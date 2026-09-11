/**
 * Phase orchestration: analyze → plan → implement → validate → report.
 *
 * Every phase receives the single {@link PipelineRun} context, so no phase ever reaches for a collaborator
 * that was not handed to it. Identity and provenance fields on every artifact written here are host-owned:
 * a model describes what it found, never who it is or what it ran against.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DeepError } from "../util/result.ts";
import { ensureDir, writeJsonAtomic, writeTextAtomic } from "../util/json.ts";
import { sha256Bytes } from "../util/sha256.ts";
import { newId, nowIso } from "../util/ids.ts";
import {
  readBridgeInventory,
  readGmlApiEntries,
  readInventory,
  readSnapshotRecord,
} from "../indexing/inventory.ts";
import { buildDependencies } from "../analysis/dependencies.ts";
import { buildGraph } from "../analysis/graph.ts";
import { findGroups } from "../analysis/cycles.ts";
import { hazardsFromApiUsage } from "../analysis/hazards.ts";
import { contradictionBetween, riskScore, reviewRequired, strategyIsJustified } from "../planning/risk.ts";
import { seedContracts } from "../planning/contracts.ts";
import { reconcile } from "../planning/reconciler.ts";
import { planTasks, type ImplementationTaskDraft } from "../planning/tasks.ts";
import { analysisCacheKey } from "./cache.ts";
import { dispatchAll, type DispatchItem } from "./scheduler.ts";
import { decideModelRetry, decideRepair } from "./retry.ts";
import { ROLE_CONFIGS } from "../agents/roles.ts";
import {
  PROMPT_VERSION,
  analystSystemPrompt,
  analystUserPrompt,
  implementerSystemPrompt,
} from "../agents/prompts.ts";
import {
  buildToolSpecs,
  validateProposedPatch,
  type ImplementerSubmission,
  type ToolBuildDeps,
} from "../agents/toolSpecs.ts";
import { mockStrategy, type MockFacts } from "../agents/mock/script.ts";
import { ZERO_USAGE } from "../agents/runtime.ts";
import {
  analysisPathFor,
  listAnalyses,
  readReview,
  writeAnalysis,
  writeReview,
} from "../evidence/store.ts";
import { diagnosticsForUnit, readConversionDiagnostics } from "../adapters/gm2godot/diagnostics.ts";
import { patchDiffPath, patchJsonPath, preimagesForRoot, renderUnifiedDiff } from "../integration/diff.ts";
import { integrateTask } from "../integration/integrator.ts";
import { patchPayloadSha256 } from "../integration/publish.ts";
import { checkCoverage } from "../validation/coverage.ts";
import { checkBehavioral } from "../validation/behavioral.ts";
import { runGodotHeadless } from "../validation/godotRun.ts";
import { checkPresentation } from "../validation/presentation.ts";
import { checkStructural } from "../validation/structural.ts";
import { persistValidation, skippedResult, type ValidationResult } from "../validation/levels.ts";
import { removeTree } from "../workspaces/workspace.ts";
import { copyTree } from "../workspaces/staging.ts";
import { writeReport } from "../evidence/report.ts";
import { repoRoot } from "../util/package.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import type { TaskRecord, UnitStrategy } from "../storage/types.ts";
import type {
  AnalysisRecord,
  ContractRecord,
  PatchRecordPayload,
  ProducedBy,
  ReviewRecord,
} from "../evidence/schemas.ts";
import {
  MOCK_USAGE,
  ensurePort,
  producedByFor,
  toolContextFor,
  type PipelineRun,
  type UnitRuntimeContext,
} from "./pipeline.ts";

// ------------------------------------------------------------------ helpers

function readUnitSource(snapshotDir: string, path: string): { path: string; sha256: string; lines: string[] } {
  const text = readFileSync(join(snapshotDir, path), "utf8");
  return { path, sha256: sha256Bytes(Buffer.from(text, "utf8")), lines: text.split("\n") };
}

/** A synthetic task record, so a unit-scoped tool context can exist before any task row does. */
function syntheticTask(role: TaskRecord["role"], id: string, keep: number): TaskRecord {
  const at = nowIso();
  return {
    id,
    unitIds: [id],
    role,
    state: "READY",
    strategy: "repair_generated",
    attempt: 1,
    maxAttempts: keep,
    allowlist: { read: [], write: [] },
    dependsOn: [],
    contractVersions: {},
    inputHash: id,
    acceptanceCheckIds: [],
    reviewRequired: false,
    budgets: { maxAttempts: 1, maxModelTokens: null, maxCostUsd: null, timeoutSeconds: 600 },
    blockReason: null,
    publishedRevision: null,
    createdAt: at,
    updatedAt: at,
  };
}

function syntheticAnalystTask(unit: AnalysisUnit): TaskRecord {
  const task = syntheticTask("analyst", unit.id, ROLE_CONFIGS.analyst.maxTurns);
  return {
    ...task,
    allowlist: {
      read: [
        ...unit.sourcePaths.map((path) => `source:${path}`),
        ...unit.generatedOutputs.map((output) => `baseline:${output.path}`),
        "evidence:inventory/inventory.json",
        "evidence:inventory/gml-api.json",
        "evidence:inventory/baseline.json",
      ],
      write: [],
    },
    acceptanceCheckIds: [],
    reviewRequired: false,
  };
}

/**
 * The unit a request is scoped to. A cycle group is scheduled as one task, so the implementer's request
 * has to be scoped to the merged composition while the analysis records stay per original unit.
 */
function unitForTask(task: TaskRecord, units: readonly AnalysisUnit[]): AnalysisUnit {
  const members = task.unitIds
    .map((id) => units.find((unit) => unit.id === id))
    .filter((unit): unit is AnalysisUnit => unit !== undefined);
  if (members.length === 1 && members[0] !== undefined) return members[0];
  const sourcePaths: string[] = [];
  const sourceHashes: Record<string, string> = {};
  const generatedOutputs: AnalysisUnit["generatedOutputs"] = [];
  const seen = new Set<string>();
  for (const member of members) {
    for (const path of member.sourcePaths) if (!sourcePaths.includes(path)) sourcePaths.push(path);
    Object.assign(sourceHashes, member.sourceHashes);
    for (const output of member.generatedOutputs) {
      if (seen.has(output.path)) continue;
      seen.add(output.path);
      generatedOutputs.push(output);
    }
  }
  return {
    id: task.id,
    kind: members[0]?.kind ?? "script",
    name: members.map((member) => member.name).join("+"),
    sourcePaths,
    sourceHashes,
    generatedOutputs,
    analysisRequired: true,
    memberUnitIds: [...task.unitIds],
  };
}

/** Build the tool context and the deterministic-runtime facts for one scoped unit. */
function unitContextFor(
  run: PipelineRun,
  task: TaskRecord,
  unit: AnalysisUnit,
  attempt: number,
): UnitRuntimeContext {
  const { workspace } = run.options;
  const inventory = run.state.inventory;
  if (inventory === null) {
    throw new DeepError("GM2DEEP-INVENTORY-MISSING", "the inventory must be built before a unit context can exist");
  }
  const dependencies = run.state.dependencies ?? { edges: [], apiUsage: [], unresolved: [] };
  const diagnostics = [...diagnosticsForUnit(readConversionDiagnostics(workspace.paths.baseline), unit.sourcePaths)];
  const toolDeps: ToolBuildDeps = {
    context: toolContextFor(run.options, task, run.options.signal, (detail) =>
      run.repo.recordInvalidation({ kind: "policy_denied", unitId: unit.id, detail }),
    ),
    task,
    unitId: unit.id,
    unitSourcePaths: unit.sourcePaths,
    unitGeneratedOutputs: unit.generatedOutputs.map((output) => output.path),
    converterDiagnostics: diagnostics,
    inventory,
  };
  const sourceFiles = unit.sourcePaths.map((path) => readUnitSource(workspace.paths.source, path));
  const portFiles: Record<string, string> = {};
  for (const output of unit.generatedOutputs) {
    const absolute = join(workspace.paths.port, output.path);
    if (existsSync(absolute)) portFiles[output.path] = readFileSync(absolute, "utf8");
  }
  const facts: MockFacts = {
    unit,
    baselineId: run.state.baselineId,
    sourceSnapshotId: readSnapshotRecord(workspace.paths.evidenceInventory).snapshotId,
    sourceFiles,
    generatedOutputs: unit.generatedOutputs.map((output) => ({ path: output.path, sha256: output.sha256 })),
    converterDiagnostics: diagnostics,
    dependencies,
    hazards: run.state.hazards.filter((hazard) => hazard.unitId === unit.id),
    apiUsage: dependencies.apiUsage.filter((usage) => usage.unitId === unit.id),
    unresolved: dependencies.unresolved.filter((entry) => entry.unitId === unit.id),
    risk: { level: "low", reasons: [] },
    strategy: "retain_generated",
    contractVersions: { ...task.contractVersions },
    writeAllowlist: unit.generatedOutputs.map((output) => output.path),
    portFiles,
    attempt,
  };
  return { toolDeps, facts: { ...facts, strategy: mockStrategy(facts) } };
}

function turnBudget(config: PipelineRun["options"]["workspace"]["config"], role: keyof typeof ROLE_CONFIGS): {
  maxTurns: number;
  timeoutSeconds: number;
} {
  return {
    maxTurns: Math.max(ROLE_CONFIGS[role].maxTurns, config.agent.maxTurnsPerTask),
    timeoutSeconds: Math.max(ROLE_CONFIGS[role].defaultTimeoutSeconds, config.agent.taskTimeoutSeconds),
  };
}

// ------------------------------------------------------------------ analyze

export async function phaseAnalyze(run: PipelineRun): Promise<void> {
  const { workspace, repo } = run.options;
  const state = run.state;
  const inventory = state.inventory ?? readInventory(workspace.paths.evidenceInventory);
  state.inventory = inventory;
  const bridge = state.bridge ?? readBridgeInventory(workspace.paths.evidenceInventory);
  state.bridge = bridge;
  state.gmlApi = state.gmlApi.length > 0 ? state.gmlApi : readGmlApiEntries(workspace.paths.evidenceInventory);
  if (state.baselineId === null) state.baselineId = inventory.baselineId;

  const dependencies = buildDependencies({
    snapshotDir: workspace.paths.source,
    units: inventory.units,
    bridge,
    gmlApiEntries: state.gmlApi,
  });
  state.dependencies = dependencies;
  const graph = buildGraph(inventory.units, dependencies);
  state.groups = findGroups(graph, inventory.units);
  // Analyses stay per original unit; a cycle group is merged only when it is scheduled as a task, so the
  // per-unit evidence survives and the group is visible as a group.
  state.units = inventory.units;
  state.hazards = hazardsFromApiUsage(dependencies, state.units);

  for (const unit of state.units) {
    repo.upsertUnit({
      id: unit.id,
      kind: unit.kind,
      name: unit.name,
      analysisRequired: unit.analysisRequired,
      deterministic: !unit.analysisRequired,
      state: "DISCOVERED",
      sourceHashes: { ...unit.sourceHashes },
    });
    const group = state.groups.find((candidate) => candidate.kind === "cycle" && candidate.unitIds.includes(unit.id));
    if (group !== undefined) repo.setUnitGroup(unit.id, group.id);
  }
  const cycleGroups = state.groups.filter((group) => group.kind === "cycle");
  if (cycleGroups.length > 0) {
    run.options.logger.info(
      `analyze: ${String(cycleGroups.length)} cycle group(s) will be scheduled as single tasks: ${cycleGroups.map((group) => group.id).join(", ")}`,
    );
  }

  const toAnalyze = state.units.filter((unit) => unit.analysisRequired);
  const cacheKeys = new Map<string, string>();
  const items: DispatchItem<AnalysisRecord>[] = [];
  for (const unit of toAnalyze) {
    const prepared = unitContextFor(run, syntheticAnalystTask(unit), unit, 1);
    run.contexts.set(unit.id, prepared);
    const edges = dependencies.edges.filter((edge) => edge.from === unit.id);
    const key = analysisCacheKey({
      unitId: unit.id,
      sourceHashes: unit.sourceHashes,
      dependencyEdges: edges.map((edge) => ({ to: edge.to, kind: edge.kind, contractVersions: {} })),
      baselineId: state.baselineId,
      gm2godotVersion: state.probe?.gm2godotVersion ?? null,
      godotVersion: workspace.config.godot.expectedVersion,
      promptVersion: PROMPT_VERSION,
      model: workspace.config.agent.model,
    });
    cacheKeys.set(unit.id, key);
    items.push({
      id: unit.id,
      run: async (signal): Promise<AnalysisRecord> => {
        const cached = run.cache.get(key);
        if (cached !== null) {
          const record = cached.value as AnalysisRecord;
          const written = writeAnalysis(workspace.paths.evidenceAnalyses, record);
          repo.upsertAnalysis({
            unitId: unit.id,
            path: analysisPathFor(workspace.paths.evidenceAnalyses, unit.id),
            sha256: written.sha256,
            schemaVersion: 1,
            riskLevel: null,
            strategy: record.strategy,
            producedBy: record.producedBy,
          });
          run.options.logger.debug(`analyze: reused cached analysis for ${unit.id}`);
          return record;
        }
        const budget = turnBudget(workspace.config, "analyst");
        const result = await run.runtime.run({
          role: "analyst",
          taskId: unit.id,
          systemPrompt: analystSystemPrompt({
            contracts: [],
            dependencySummary: edges.map((edge) => `${edge.kind}->${edge.to} (${edge.confidence})`).join(", ") || "no outgoing edges recorded",
          }),
          userPrompt: analystUserPrompt(
            unit.id,
            unit.kind,
            unit.sourcePaths,
            unit.generatedOutputs.map((output) => output.path),
          ),
          tools: buildToolSpecs("analyst", prepared.toolDeps),
          workspaceRoots: prepared.toolDeps.context.workspaceRoots,
          allowlist: prepared.toolDeps.context.allowlist,
          resultSchema: ROLE_CONFIGS.analyst.resultSchema,
          maxTurns: budget.maxTurns,
          timeoutSeconds: budget.timeoutSeconds,
          budgets: {
            tokens: workspace.config.agent.budgets.perTaskTokens,
            costUsd: workspace.config.agent.budgets.perTaskCostUsd,
          },
          signal,
          credentials: run.credentials,
          attempt: 1,
          logger: run.options.logger,
          recordPolicyDenial: (detail) =>
            run.repo.recordInvalidation({ kind: "policy_denied", unitId: unit.id, detail }),
        });
        run.budget.charge(unit.id, result.usage);
        if (result.outcome !== "completed" || result.result === undefined) {
          throw new DeepError("GM2DEEP-ANALYSIS-UNPRODUCED", `analysis of ${unit.id} produced no result: ${result.outcome}`, {
            unitId: unit.id,
            outcome: result.outcome,
            reason: result.reason ?? null,
          });
        }
        const record = assembleAnalysis(run, unit, result.result as Record<string, unknown>, producedByFor(run.options, result.usage));
        const written = writeAnalysis(workspace.paths.evidenceAnalyses, record);
        repo.upsertAnalysis({
          unitId: unit.id,
          path: analysisPathFor(workspace.paths.evidenceAnalyses, unit.id),
          sha256: written.sha256,
          schemaVersion: 1,
          riskLevel: null,
          strategy: record.strategy,
          producedBy: record.producedBy,
        });
        run.cache.put(key, unit.id, "analysis", record);
        return record;
      },
    });
  }

  const outcomes = await dispatchAll(items, {
    maxWorkers: run.options.maxWorkers ?? workspace.config.concurrency.analysis,
    leases: run.leases,
    budget: run.budget,
    logger: run.options.logger,
    signal: run.options.signal,
    canDispatch: () => ({ allowed: true, reason: null }),
    onSettled: async (outcome) => {
      if (outcome.skippedReason !== null) run.skipped.push(`${outcome.id}: ${outcome.skippedReason}`);
      if (!outcome.ok) run.failed.push(`${outcome.id}: ${String(outcome.error)}`);
      if (outcome.ok) repo.setUnitState(outcome.id, "ANALYZED");
    },
  });
  for (const outcome of outcomes) {
    if (outcome.ok) continue;
    repo.setUnitState(outcome.id, "BLOCKED");
    const unit = state.units.find((candidate) => candidate.id === outcome.id);
    if (unit !== undefined) {
      repo.recordInvalidation({
        kind: "analysis_blocked",
        unitId: unit.id,
        detail: { reason: outcome.error === null ? outcome.skippedReason : String(outcome.error) },
      });
    }
  }

  // Risk and review pass over the analyses that actually landed on disk.
  state.analyses = new Map(listAnalyses(workspace.paths.evidenceAnalyses).map((record) => [record.unitId, record]));
  const sharedInterface = new Set(
    dependencies.edges
      .filter((edge) => edge.confidence === "confirmed" && edge.kind !== "shared_state")
      .map((edge) => edge.to),
  );
  for (const unit of state.units) {
    if (!unit.analysisRequired) {
      repo.setUnitState(unit.id, "ANALYZED");
      continue;
    }
    const record = state.analyses.get(unit.id);
    if (record === undefined) continue;
    repo.setUnitStrategy(unit.id, record.strategy);
    const dependencyRecord = dependencies.edges
      .filter((edge) => edge.from === unit.id && edge.confidence !== "unresolved")
      .map((edge) => state.analyses.get(edge.to) ?? null)
      .find((candidate): candidate is AnalysisRecord => candidate !== null) ?? null;
    const contradiction = contradictionBetween(record, dependencyRecord);
    const risk = riskScore({
      unitId: unit.id,
      record,
      review: null,
      edges: dependencies.edges.filter((edge) => edge.from === unit.id),
      dependents: dependencies.edges.filter((edge) => edge.to === unit.id).map((edge) => edge.from),
      inCycle: state.groups.some((group) => group.kind === "cycle" && group.unitIds.includes(unit.id)),
      ownsContractRule: sharedInterface.has(unit.id),
      unresolvedFeedsResourceIdentity: record.dependencies.unresolved.some((entry) =>
        /asset_get_index|script_execute/.test(entry.symbol),
      ),
    });
    repo.setUnitRisk(unit.id, risk);
    state.risks.set(unit.id, risk);
    if (!strategyIsJustified(record)) {
      run.options.logger.warn(`analysis for ${unit.id} chose ${record.strategy} without a sufficient rationale`);
    }
    const trigger = reviewRequired({
      risk,
      ownsSharedInterface: sharedInterface.has(unit.id),
      contractChanged: false,
      requireReviewFor: workspace.config.policy.requireReviewFor,
      hasUncertainties: record.uncertainties.length > 0,
      contradictsDependency: contradiction !== null,
    });
    if (!trigger.required) continue;
    const prepared = run.contexts.get(unit.id);
    if (prepared === undefined) continue;
    run.contexts.set(`${unit.id}#review`, prepared);
    const reviewKey = `${cacheKeys.get(unit.id) ?? unit.id}:review`;
    const cachedReview = run.cache.get(reviewKey);
    if (cachedReview !== null) {
      const cached = cachedReview.value as ReviewRecord;
      writeReview(workspace.paths.evidenceAnalyses, cached);
      state.reviews.set(unit.id, cached);
      continue;
    }
    const reviewBudget = turnBudget(workspace.config, "risk_reviewer");
    const reviewResult = await run.runtime.run({
      role: "risk_reviewer",
      taskId: `${unit.id}#review`,
      systemPrompt: `Review the analyst record for ${unit.id}.`,
      userPrompt: JSON.stringify(record, null, 2).slice(0, 60_000),
      tools: buildToolSpecs("risk_reviewer", prepared.toolDeps),
      workspaceRoots: prepared.toolDeps.context.workspaceRoots,
      allowlist: prepared.toolDeps.context.allowlist,
      resultSchema: ROLE_CONFIGS.risk_reviewer.resultSchema,
      maxTurns: reviewBudget.maxTurns,
      timeoutSeconds: reviewBudget.timeoutSeconds,
      budgets: { tokens: null, costUsd: null },
      signal: run.options.signal,
      credentials: run.credentials,
      attempt: 1,
      logger: run.options.logger,
      recordPolicyDenial: (detail) =>
        run.repo.recordInvalidation({ kind: "policy_denied", unitId: unit.id, detail }),
    });
    run.budget.charge(unit.id, reviewResult.usage);
    if (reviewResult.outcome !== "completed" || reviewResult.result === undefined) {
      run.skipped.push(`${unit.id}: risk review did not complete (${reviewResult.outcome})`);
      continue;
    }
    const review: ReviewRecord = {
      ...(reviewResult.result as Omit<ReviewRecord, "schemaVersion" | "unitId" | "producedBy">),
      schemaVersion: 1,
      unitId: unit.id,
      producedBy: producedByFor(run.options, reviewResult.usage),
    };
    const written = writeReview(workspace.paths.evidenceAnalyses, review);
    run.cache.put(reviewKey, unit.id, "review", review);
    state.reviews.set(unit.id, review);
    repo.recordInvalidation({ kind: "risk_review", unitId: unit.id, detail: { scenarios: written.sha256, reasons: trigger.reasons } });
    const refuted = review.challenges.filter((challenge) => challenge.verdict === "refuted");
    if (refuted.length > 0) {
      repo.recordInvalidation({ kind: "review_contradiction", unitId: unit.id, detail: refuted });
      run.options.logger.warn(`review refuted ${String(refuted.length)} claim(s) of ${unit.id}; escalated to planning`);
    }
  }
  run.options.logger.info(`analyze: ${String(state.analyses.size)} analysis record(s) recorded`);
}

function assembleAnalysis(
  run: PipelineRun,
  unit: AnalysisUnit,
  payload: Record<string, unknown>,
  producedBy: ProducedBy,
): AnalysisRecord {
  const snapshot = readSnapshotRecord(run.options.workspace.paths.evidenceInventory);
  const diagnostics = diagnosticsForUnit(
    readConversionDiagnostics(run.options.workspace.paths.baseline),
    unit.sourcePaths,
  );
  return {
    ...(payload as Omit<
      AnalysisRecord,
      | "schemaVersion"
      | "unitId"
      | "unitKind"
      | "sourceSnapshotId"
      | "baselineId"
      | "sourcePaths"
      | "generatedOutputs"
      | "converterDiagnostics"
      | "producedBy"
    >),
    schemaVersion: 1,
    unitId: unit.id,
    unitKind: unit.kind,
    sourceSnapshotId: snapshot.snapshotId,
    baselineId: run.state.baselineId,
    // The unit's own file list is authoritative; the payload's list is the model's claim about what it read.
    sourcePaths: unit.sourcePaths.map((path) => ({
      path,
      sha256: unit.sourceHashes[path] ?? sha256Bytes(Buffer.from("", "utf8")),
    })),
    generatedOutputs: unit.generatedOutputs.map((output) => ({
      path: output.path,
      sha256: output.sha256,
      ...(output.sourceMapPath === null ? {} : { sourceMapPath: output.sourceMapPath }),
    })),
    converterDiagnostics: [...diagnostics],
    producedBy,
  };
}

// --------------------------------------------------------------------- plan

export async function phasePlan(run: PipelineRun): Promise<void> {
  const { workspace, repo } = run.options;
  const state = run.state;
  const inventory = state.inventory ?? readInventory(workspace.paths.evidenceInventory);
  state.inventory = inventory;
  if (state.units.length === 0) state.units = inventory.units;
  if (state.dependencies === null) {
    throw new DeepError("GM2DEEP-ANALYZE-MISSING", "the dependency graph must be built before planning");
  }
  state.analyses = new Map(listAnalyses(workspace.paths.evidenceAnalyses).map((record) => [record.unitId, record]));
  for (const unitId of state.analyses.keys()) {
    const review = readReview(workspace.paths.evidenceAnalyses, unitId);
    if (review !== null) state.reviews.set(unitId, review);
  }

  state.seeds = seedContracts(workspace.paths.baseline, inventory).contracts;
  run.contexts.set(
    "reconcile",
    unitContextFor(
      run,
      syntheticTask("reconciler", "reconcile", 1),
      { id: "reconcile", kind: "project_settings", name: "reconcile", sourcePaths: [], sourceHashes: {}, generatedOutputs: [], analysisRequired: false },
      1,
    ),
  );

  const planBudget = turnBudget(workspace.config, "reconciler");
  const outcome = await reconcile({
    workspace,
    repo,
    runtime: run.runtime,
    inventory,
    units: state.units,
    analyses: state.analyses,
    dependencies: state.dependencies,
    seeds: state.seeds,
    planVersion: run.planVersion,
    producedBy: producedByFor(run.options, run.runtime.simulated ? MOCK_USAGE : ZERO_USAGE),
    signal: run.options.signal,
    maxTurns: planBudget.maxTurns,
    timeoutSeconds: planBudget.timeoutSeconds,
    budgets: {
      tokens: workspace.config.agent.budgets.perTaskTokens,
      costUsd: workspace.config.agent.budgets.perTaskCostUsd,
    },
    credentials: run.credentials,
    logger: run.options.logger,
  });
  state.plan = outcome.plan;
  state.contracts = [...outcome.contracts];
  run.options.logger.info(
    `plan: v${String(outcome.plan.version)} with ${String(outcome.contracts.length)} contract(s) at ${outcome.planPath}`,
  );

  const drafts = planTasks({
    units: state.units,
    groups: state.groups,
    analyses: state.analyses,
    reviews: state.reviews,
    dependencies: state.dependencies,
    contracts: outcome.contracts,
    plan: outcome.plan,
    risks: state.risks,
    policy: {
      requireReviewFor: workspace.config.policy.requireReviewFor,
      maxTaskAttempts: workspace.config.policy.maxTaskAttempts,
      taskTimeoutSeconds: workspace.config.agent.taskTimeoutSeconds,
      perTaskTokens: workspace.config.agent.budgets.perTaskTokens,
      perTaskCostUsd: workspace.config.agent.budgets.perTaskCostUsd,
    },
  });

  const contradicted = new Set(
    [...state.reviews.values()]
      .filter((review) => review.challenges.some((challenge) => challenge.verdict === "refuted"))
      .map((review) => review.unitId),
  );

  for (const draft of drafts.tasks) {
    const refuted = draft.unitIds.filter((unitId) => contradicted.has(unitId));
    const blockReason =
      draft.blockReason ??
      (refuted.length === 0
        ? null
        : `a review refuted the analysis of ${refuted.join(", ")}; the contradiction is escalated, never resolved by rewriting`);
    state.drafts.set(draft.id, { ...draft, blockReason });
    for (const concern of Object.keys(draft.contractVersions)) {
      const version = draft.contractVersions[concern];
      if (version === undefined) continue;
      const contract = outcome.contracts.find((candidate) => candidate.concern === concern);
      if (contract === undefined) continue;
      for (const rule of contract.rules) {
        for (const unitId of draft.unitIds) repo.bindContractRule(concern, version, unitId, rule.id);
      }
    }

    const existing = repo.getTask(draft.id);
    if (existing !== null) {
      // Re-planning must never destroy progress: an ACCEPTED task stays accepted, and a task that is
      // mid-flight is left for `resume`. Only a task still at PLANNED is advanced.
      if (existing.state === "PLANNED") {
        if (blockReason === null) {
          run.machine.transition(draft.id, "READY", { detail: { strategy: draft.strategy, unitIds: draft.unitIds } });
        } else {
          repo.setTaskBlockReason(draft.id, blockReason);
          run.machine.transition(draft.id, "BLOCKED", { detail: { reason: blockReason } });
          run.blocked.push(`${draft.id}: ${blockReason}`);
        }
      } else if (existing.inputHash !== draft.inputHash) {
        repo.recordInvalidation({
          kind: "task_input_changed",
          unitId: draft.unitIds[0] ?? draft.id,
          detail: { taskId: draft.id, state: existing.state, recorded: existing.inputHash, planned: draft.inputHash },
        });
        run.options.logger.warn(
          `plan: ${draft.id} already exists in state ${existing.state} with a different input hash; left untouched and recorded as an invalidation`,
        );
      }
      continue;
    }

    repo.insertTask({
      id: draft.id,
      unitIds: draft.unitIds,
      role: "implementer",
      state: "PLANNED",
      strategy: draft.strategy,
      maxAttempts: draft.budgets.maxAttempts,
      allowlist: draft.allowlist,
      dependsOn: draft.dependsOn,
      contractVersions: { ...draft.contractVersions },
      inputHash: draft.inputHash,
      acceptanceCheckIds: draft.acceptanceCheckIds,
      reviewRequired: draft.reviewRequired,
      budgets: draft.budgets,
      blockReason,
    });
    if (blockReason === null) {
      run.machine.transition(draft.id, "READY", { detail: { strategy: draft.strategy, unitIds: draft.unitIds } });
      for (const unitId of draft.unitIds) repo.setUnitState(unitId, "PLANNED");
    } else {
      repo.setTaskBlockReason(draft.id, blockReason);
      run.machine.transition(draft.id, "BLOCKED", { detail: { reason: blockReason } });
      run.blocked.push(`${draft.id}: ${blockReason}`);
      for (const unitId of draft.unitIds) repo.setUnitState(unitId, "BLOCKED");
    }
  }

  for (const retained of drafts.retained) {
    const before = repo.getUnit(retained.unitId);
    repo.setUnitStrategy(retained.unitId, "retain_generated");
    if (before?.state !== "ACCEPTED") repo.setUnitState(retained.unitId, "ACCEPTED");
    if (before?.strategy !== "retain_generated") {
      repo.recordInvalidation({ kind: "retained_unit", unitId: retained.unitId, detail: { reason: retained.reason } });
    }
  }
  run.options.logger.info(
    `plan: ${String(drafts.tasks.length)} task(s), ${String(drafts.retained.length)} retained unit(s), ${String(drafts.blocked.length)} blocked`,
  );
}

// ---------------------------------------------------------------- implement

interface RunChecksInput {
  readonly run: PipelineRun;
  readonly task: TaskRecord;
  readonly attempt: number;
}

async function runCandidateChecks(input: RunChecksInput, candidateDir: string): Promise<readonly ValidationResult[]> {
  const { run, task, attempt } = input;
  const { workspace } = run.options;
  const safe = task.id.replace(/[:/]/g, "_");
  const inputRevision = `candidate:${task.id}:attempt-${String(attempt)}`;
  const expectedGodot = {
    expectedVersion: workspace.config.godot.expectedVersion,
    expectedVersionPrefix: workspace.config.godot.expectedVersionPrefix,
  };
  const structural = await checkStructural({
    projectPath: candidateDir,
    godotBinary: run.state.godotBinary,
    gm2godotCheckout: workspace.config.gm2godot.checkout,
    python: run.state.python,
    timeoutSeconds: workspace.config.gm2godot.timeoutSeconds,
    reportDir: ensureDir(join(workspace.paths.validation, safe, `attempt-${String(attempt)}`, "reports")),
    inputRevision,
    repoRoot,
    expectedGodot,
  });
  const behavioral = await behavioralCheck(run, {
    candidateProjectDir: candidateDir,
    workspaceValidationDir: join(workspace.paths.validation, `${safe}-attempt-${String(attempt)}`),
    checkId: `candidate-behavioral:${safe}:attempt-${String(attempt)}`,
    inputRevision,
  });
  const renamed = [...structural, behavioral].map((check) => ({ ...check, checkId: `candidate-${safe}-${check.checkId}` }));
  persistValidation({ dir: workspace.paths.evidenceValidation, repo: run.repo, taskId: task.id }, renamed);
  return renamed;
}

interface BehavioralInput {
  readonly candidateProjectDir: string;
  readonly workspaceValidationDir: string;
  readonly checkId: string;
  readonly inputRevision: string;
}

/** Level D against the shipped scenario and recorded expectation; `skipped` when either is absent. */
async function behavioralCheck(run: PipelineRun, input: BehavioralInput): Promise<ValidationResult> {
  const { workspace } = run.options;
  const scenario = join(repoRoot, "fixtures", "scenarios", "counter_trace.gd");
  const expected = join(repoRoot, "fixtures", "traces", "counter_expected.json");
  const identity = {
    level: "D" as const,
    checkId: input.checkId,
    name: "level D behavioural — scenario trace comparison",
    inputRevision: input.inputRevision,
  };
  if (!existsSync(scenario) || !existsSync(expected)) {
    const missing = [scenario, expected].filter((path) => !existsSync(path));
    return skippedResult({
      ...identity,
      reason: `no recorded expectation is present (missing ${missing.join(", ")}), so there is nothing to compare against`,
    });
  }
  return checkBehavioral({
    candidateProjectDir: input.candidateProjectDir,
    scenarioSourcePath: scenario,
    expectedTracePath: expected,
    workspaceValidationDir: input.workspaceValidationDir,
    godotBinary: run.state.godotBinary,
    timeoutSeconds: workspace.config.godot.timeoutSeconds,
    inputRevision: input.inputRevision,
    checkId: input.checkId,
    expectedGodot: {
      expectedVersion: workspace.config.godot.expectedVersion,
      expectedVersionPrefix: workspace.config.godot.expectedVersionPrefix,
    },
  });
}

export async function phaseImplement(run: PipelineRun): Promise<void> {
  const { workspace, repo } = run.options;
  const state = run.state;
  const port = ensurePort(run);
  const filter = new Set(run.options.taskFilter);
  let tasks = repo.listTasksInState("READY");
  if (filter.size > 0) tasks = tasks.filter((task) => filter.has(task.id));
  if (tasks.length === 0) {
    run.options.logger.info("implement: no READY task to run");
    return;
  }

  for (const initial of tasks) {
    let task = initial;
    let repairAttempts = 0;
    const diagnosis: string[] = [];
    for (;;) {
      run.machine.transition(task.id, "RUNNING", { incrementAttempt: true });
      task = repo.getTask(task.id) ?? task;
      const unit = unitForTask(task, state.units);
      run.contexts.set(task.id, unitContextFor(run, task, unit, task.attempt));
      const prepared = run.contexts.get(task.id);
      if (prepared === undefined) throw new DeepError("GM2DEEP-RUNTIME-CONTEXT-MISSING", `no context for ${task.id}`);
      const budget = turnBudget(workspace.config, "implementer");
      const result = await run.runtime.run({
        role: "implementer",
        taskId: task.id,
        systemPrompt: implementerSystemPrompt({
          contracts: state.contracts,
          dependencySummary: `${task.unitIds.join(", ")}; write allowlist ${task.allowlist.write.join(", ") || "none"}`,
          ...(diagnosis.length === 0 ? {} : { extra: `Previous attempt failed:\n${diagnosis.join("\n")}` }),
        }),
        userPrompt: [
          `Produce the patch for task ${task.id} (strategy ${task.strategy}).`,
          `Units: ${task.unitIds.join(", ")}`,
          `Write allowlist: ${task.allowlist.write.join(", ") || "none"}`,
          ...(diagnosis.length === 0 ? [] : ["", "Failing evidence from the previous attempt:", ...diagnosis]),
        ].join("\n"),
        tools: buildToolSpecs("implementer", prepared.toolDeps),
        workspaceRoots: prepared.toolDeps.context.workspaceRoots,
        allowlist: prepared.toolDeps.context.allowlist,
        resultSchema: ROLE_CONFIGS.implementer.resultSchema,
        maxTurns: budget.maxTurns,
        timeoutSeconds: budget.timeoutSeconds,
        budgets: { tokens: task.budgets.maxModelTokens, costUsd: task.budgets.maxCostUsd },
        signal: run.options.signal,
        credentials: run.credentials,
        attempt: task.attempt,
        logger: run.options.logger,
        recordPolicyDenial: (detail) => run.machine.record(task.id, "policy_denied", detail),
      });
      const budgetDecision = run.budget.charge(task.id, result.usage);

      if (result.outcome !== "completed" || result.result === undefined) {
        run.machine.record(task.id, "failure", {
          reason: result.reason ?? result.outcome,
          outcome: result.outcome,
        });
        run.machine.transition(task.id, "FAILED", { detail: { reason: result.reason ?? result.outcome } });
        const decision = decideModelRetry(task, [result.reason ?? result.outcome]);
        if (decision.action === "retry") {
          run.machine.transition(task.id, "READY", {
            reason: "retry",
            detail: { reason: decision.reason, context: decision.context },
          });
          diagnosis.push(...decision.context);
          task = repo.getTask(task.id) ?? task;
          continue;
        }
        run.failed.push(`${task.id}: ${decision.reason}`);
        break;
      }

      const submission = result.result as ImplementerSubmission;
      const payload: PatchRecordPayload = {
        schemaVersion: 1,
        taskId: task.id,
        attempt: task.attempt,
        basePortRevision: repo.currentPortRevision(),
        inputHash: task.inputHash,
        contractVersions: { ...task.contractVersions },
        files: submission.files,
        summary: submission.summary,
        producedBy: producedByFor(run.options, result.usage),
      };
      try {
        validateProposedPatch(task, submission);
      } catch (error) {
        const reason = error instanceof DeepError ? `${error.code}: ${error.message}` : String(error);
        run.machine.record(task.id, "failure", { reason, outcome: "invalid_patch" });
        run.machine.transition(task.id, "FAILED", { detail: { reason } });
        const decision = decideModelRetry(task, [reason]);
        if (decision.action === "retry") {
          run.machine.transition(task.id, "READY", {
            reason: "retry",
            detail: { reason: decision.reason },
          });
          diagnosis.push(reason);
          task = repo.getTask(task.id) ?? task;
          continue;
        }
        run.failed.push(`${task.id}: ${decision.reason}`);
        break;
      }

      const jsonPath = patchJsonPath(workspace.paths.evidencePatches, task.id, task.attempt);
      const diffPath = patchDiffPath(workspace.paths.evidencePatches, task.id, task.attempt);
      writeJsonAtomic(jsonPath, payload);
      writeTextAtomic(diffPath, renderUnifiedDiff(payload, { preimages: preimagesForRoot(port, payload) }));
      const patchSha256 = patchPayloadSha256(payload);
      const patchId = newId("patch");
      repo.insertPatch({
        id: patchId,
        taskId: task.id,
        attempt: task.attempt,
        sha256: patchSha256,
        path: jsonPath,
        diffPath,
        basePortRevision: payload.basePortRevision,
      });
      run.machine.transition(task.id, "IMPLEMENTED", { detail: { patchSha256, patchId } });
      run.machine.transition(task.id, "VALIDATING", { detail: { patchId, attempt: task.attempt } });

      const outcome = await integrateTask({
        workspace,
        repo,
        task,
        payload,
        currentContractVersions: repo.latestContractVersions(),
        currentPortRevision: repo.currentPortRevision(),
        expectedInputHash: task.inputHash,
        baselineId: state.baselineId ?? "",
        currentBaselineId: state.baselineId ?? "",
        runtime: run.runtime,
        workspaceRoots: prepared.toolDeps.context.workspaceRoots,
        credentials: run.credentials,
        signal: run.options.signal,
        runChecks: (candidateDir) => runCandidateChecks({ run, task, attempt: task.attempt }, candidateDir),
        contracts: state.contracts,
        tools: buildToolSpecs("patch_reviewer", {
          ...prepared.toolDeps,
          context: { ...prepared.toolDeps.context, role: "patch_reviewer" },
        }),
        logger: run.options.logger,
        recordPolicyDenial: (detail) => run.machine.record(task.id, "policy_denied", detail),
        portMutex: run.portMutex,
      });

      const failedChecks = outcome.checks.filter((check) => check.state === "failed");
      for (const check of failedChecks) {
        run.machine.record(task.id, "check_failed", {
          checkId: check.checkId,
          level: check.level,
          state: check.state,
          ...(check.reason === undefined ? {} : { reason: check.reason }),
        });
      }
      if (outcome.review !== null) {
        run.machine.record(task.id, "review", {
          verdict: outcome.review.verdict,
          reasons: outcome.review.reasons,
          reviewerNotes: outcome.review.reviewerNotes,
        });
      }

      if (outcome.state === "accepted") {
        repo.setPatchState(patchId, "published");
        run.machine.transition(task.id, "ACCEPTED", {
          detail: { revision: outcome.revision, integrationId: outcome.integrationId, patchSha256 },
        });
        if (outcome.revision !== null) repo.setTaskPublishedRevision(task.id, outcome.revision);
        run.machine.record(task.id, "integration", {
          state: "accepted",
          reasons: outcome.reasons,
          revision: outcome.revision,
          integrationId: outcome.integrationId,
          patchSha256,
          review:
            outcome.review === null
              ? null
              : {
                  verdict: outcome.review.verdict,
                  reasons: outcome.review.reasons,
                  reviewerNotes: outcome.review.reviewerNotes,
                },
        });
        for (const unitId of task.unitIds) repo.setUnitState(unitId, "ACCEPTED");
        run.options.logger.info(`implement: ${task.id} accepted at port revision ${String(outcome.revision)}`);
        break;
      }

      repo.setPatchState(patchId, "rejected");
      run.machine.record(task.id, "integration", {
        state: "rejected",
        reasons: outcome.reasons,
        revision: null,
        integrationId: null,
        patchSha256,
        review:
          outcome.review === null
            ? null
            : {
                verdict: outcome.review.verdict,
                reasons: outcome.review.reasons,
                reviewerNotes: outcome.review.reviewerNotes,
              },
      });
      const failing = failedChecks.map((check) => `${check.level}:${check.checkId}`);
      const repair = decideRepair(
        repairAttempts,
        { maxTaskAttempts: task.maxAttempts, maxRepairAttempts: workspace.config.policy.maxRepairAttempts },
        failing.length > 0 ? failing : outcome.reasons,
      );
      run.machine.record(task.id, "repair", {
        repairAttempt: repair.repairAttempt,
        decision: repair.action,
        failingChecks: failing,
      });
      diagnosis.push(...outcome.reasons, ...failedChecks.map((check) => `level ${check.level} ${check.checkId}: ${check.reason ?? ""}`));
      if (repair.action === "repair") {
        run.machine.transition(task.id, "REPAIR_REQUIRED", { detail: { reason: repair.reason } });
        repairAttempts = repair.repairAttempt;
        task = repo.getTask(task.id) ?? task;
        continue;
      }
      run.machine.transition(task.id, "BLOCKED", { detail: { reason: repair.reason } });
      repo.setTaskBlockReason(task.id, repair.reason);
      run.blocked.push(`${task.id}: ${repair.reason}`);
      break;
    }
  }
}

// ----------------------------------------------------------------- validate

export async function phaseValidate(run: PipelineRun): Promise<void> {
  const { workspace, repo } = run.options;
  const state = run.state;
  const inventory = state.inventory ?? readInventory(workspace.paths.evidenceInventory);
  state.inventory = inventory;
  if (state.units.length === 0) state.units = inventory.units;
  const unitIds = new Set(state.units.map((unit) => unit.id));
  const port = ensurePort(run);
  const inputRevision = `port@${String(repo.currentPortRevision())}`;
  const expectedGodot = {
    expectedVersion: workspace.config.godot.expectedVersion,
    expectedVersionPrefix: workspace.config.godot.expectedVersionPrefix,
  };

  // Level A — every file and unit carries exactly one disposition.
  const strategyDisposition: Record<UnitStrategy, string> = {
    retain_generated: "retained",
    repair_generated: "repaired",
    replace_component: "replaced",
    blocked: "blocked",
  };
  const dispositions: Record<string, string> = {};
  for (const unit of state.units) {
    if (!unit.analysisRequired) {
      dispositions[unit.id] = "deterministic_only";
      continue;
    }
    const record = state.analyses.get(unit.id);
    dispositions[unit.id] = record === undefined ? "blocked" : strategyDisposition[record.strategy];
  }
  const fileDispositions: Record<string, string> = {};
  for (const file of inventory.files) {
    if (file.classification === "excluded") {
      fileDispositions[file.path] = `excluded(${file.classificationReason.length > 0 ? file.classificationReason : "no reason recorded"})`;
      continue;
    }
    const owner = state.units.find((unit) => unitIds.has(unit.id) && unit.sourcePaths.includes(file.path));
    if (owner === undefined) continue;
    fileDispositions[file.path] = dispositions[owner.id] ?? "blocked";
  }
  const coverage = checkCoverage({
    units: state.units,
    inventory,
    dispositions,
    fileDispositions,
    inputRevision,
  });

  // Level B — structural, against a copy: the converter's own validate writes inside the project it sees.
  const levelB = ensureDir(join(workspace.paths.validation, "level-b"));
  removeTree(levelB);
  mkdirSync(levelB, { recursive: true });
  copyTree(port, levelB);
  const structural = await checkStructural({
    projectPath: levelB,
    godotBinary: state.godotBinary,
    gm2godotCheckout: workspace.config.gm2godot.checkout,
    python: state.python,
    timeoutSeconds: workspace.config.gm2godot.timeoutSeconds,
    reportDir: ensureDir(join(workspace.paths.validation, "level-b-reports")),
    inputRevision,
    repoRoot,
    expectedGodot,
  });

  // Level C — a real headless boot of the port with a generated SceneTree script.
  const levelC = ensureDir(join(workspace.paths.validation, "level-c"));
  removeTree(levelC);
  mkdirSync(levelC, { recursive: true });
  copyTree(port, levelC);
  const bootScript = join(levelC, "tools", "deep_boot.gd");
  writeTextAtomic(
    bootScript,
    [
      "# Generated by gm2godot-deep: boots the project headlessly and exits immediately.",
      "extends SceneTree",
      "",
      "func _initialize() -> void:",
      "\tquit(0)",
      "",
    ].join("\n"),
  );
  const boot: ValidationResult =
    state.godotBinary === null
      ? skippedResult({
          level: "C",
          checkId: "runtime-boot",
          name: "level C runtime — headless boot of the port",
          inputRevision,
          reason: "godot binary not configured or not found",
        })
      : await runGodotHeadless({
          binary: state.godotBinary,
          projectPath: levelC,
          scriptPath: "tools/deep_boot.gd",
          timeoutSeconds: workspace.config.godot.timeoutSeconds,
          logsDir: ensureDir(join(workspace.paths.validation, "logs")),
          checkId: "runtime-boot",
          inputRevision,
          level: "C",
          name: "level C runtime — headless boot of the port",
          expectedGodot,
        });

  const behavioral = await behavioralCheck(run, {
    candidateProjectDir: port,
    workspaceValidationDir: join(workspace.paths.validation, "behavioral"),
    checkId: "behavioral-trace",
    inputRevision,
  });

  const presentation = checkPresentation({
    projectPath: port,
    godotBinary: state.godotBinary,
    hasAudioDevice: false,
    exportTemplateInstalled: false,
    inputRevision,
  });

  const results: ValidationResult[] = [coverage, ...structural, boot, behavioral, ...presentation];
  persistValidation({ dir: workspace.paths.evidenceValidation, repo }, results);
  for (const result of results) {
    if (result.state === "skipped") run.skipped.push(`${result.checkId}: ${result.reason ?? "skipped"}`);
    else if (result.state === "failed") run.failed.push(`${result.checkId}: ${result.reason ?? "failed"}`);
    else if (result.state === "inconclusive") run.skipped.push(`${result.checkId}: inconclusive — ${result.reason ?? "no reason"}`);
  }
  run.options.logger.info(
    `validate: ${String(results.filter((result) => result.state === "passed").length)} passed, ${String(results.filter((result) => result.state === "failed").length)} failed, ${String(results.filter((result) => result.state === "skipped").length)} skipped`,
  );
}

// ------------------------------------------------------------------- report

export async function phaseReport(run: PipelineRun): Promise<void> {
  const written = await writeReport({
    workspace: run.options.workspace,
    repo: run.repo,
    logger: run.options.logger,
  });
  run.options.logger.info(`report: ${written.markdownPath}`);
}
