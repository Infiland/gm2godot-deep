import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DeepError } from "../util/result.ts";
import { writeJsonAtomic, writeTextAtomic } from "../util/json.ts";
import { sha256Bytes } from "../util/sha256.ts";
import { newId, nowIso } from "../util/ids.ts";
import { readInventory, readBridgeInventory, readGmlApiEntries, readSnapshotRecord } from "../indexing/inventory.ts";
import { buildDependencies } from "../analysis/dependencies.ts";
import { buildGraph } from "../analysis/graph.ts";
import { applyGroups, findGroups, mutexPathsFor } from "../analysis/cycles.ts";
import { hazardsFromApiUsage } from "../analysis/hazards.ts";
import { scanGml } from "../analysis/gml/scanner.ts";
import { collectMacros } from "../analysis/gml/macros.ts";
import { riskScore, reviewRequired, strategyIsJustified } from "../planning/risk.ts";
import { seedContracts } from "../planning/contracts.ts";
import { reconcile } from "../planning/reconciler.ts";
import { planTasks, taskIdFor } from "../planning/tasks.ts";
import { AnalysisCache, analysisCacheKey } from "./cache.ts";
import { BudgetLedger } from "./budgets.ts";
import type { LeaseManager } from "./leases.ts";
import { TaskMachine } from "./machine.ts";
import { dispatchAll, type DispatchItem } from "./scheduler.ts";
import { decideRepair } from "./retry.ts";
import { ROLE_CONFIGS } from "../agents/roles.ts";
import { buildToolSpecs, validateProposedPatch, type ImplementerSubmission, type ToolBuildDeps } from "../agents/toolSpecs.ts";
import type { MockFacts } from "../agents/mock/script.ts";
import type { AnalysisRecord, ConverterDiagnostic, ProducedBy, ReviewRecord, PatchRecordPayload } from "../evidence/schemas.ts";
import {
  listAnalyses,
  recordValidation,
  validateAnalysisEvidence,
  writeAnalysis,
  writeReview,
  writeValidation,
} from "../evidence/store.ts";
import { diagnosticsForUnit, readConversionDiagnostics } from "../adapters/gm2godot/diagnostics.ts";
import { patchDiffPath, patchJsonPath, renderUnifiedDiff } from "../integration/diff.ts";
import { integrateTask } from "../integration/integrator.ts";
import { checkCoverage } from "../validation/coverage.ts";
import { checkBehavioral } from "../validation/behavioral.ts";
import { runGodotHeadless } from "../validation/godotRun.ts";
import { checkPresentation } from "../validation/presentation.ts";
import { checkStructural } from "../validation/structural.ts";
import type { ValidationResult } from "../validation/levels.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import type { TaskRecord, UnitStrategy } from "../storage/types.ts";
import type { AgentRuntime, ToolContext, Usage } from "../agents/runtime.ts";
import { repoRoot } from "../util/package.ts";
import {
  MOCK_USAGE,
  producedByFor,
  runtimeFor,
  toolContextFor,
  type Phase,
  type PipelineOptions,
  type PipelineState,
} from "./pipeline.ts";

const DEEP_REPO_ROOT = repoRoot;

async function readUnitSource(snapshotDir: string, path: string): Promise<{ path: string; sha256: string; lines: string[] }> {
  const text = readFileSync(join(snapshotDir, path), "utf8");
  return { path, sha256: sha256Bytes(Buffer.from(text, "utf8")), lines: text.split("\n") };
}

function syntheticAnalystTask(unit: AnalysisUnit): TaskRecord {
  const at = nowIso();
  return {
    id: unit.id,
    unitIds: [unit.id],
    role: "analyst",
    state: "READY",
    strategy: "repair_generated",
    attempt: 1,
    maxAttempts: ROLE_CONFIGS.analyst.maxTurns,
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
    dependsOn: [],
    contractVersions: {},
    inputHash: unit.id,
    acceptanceCheckIds: [],
    reviewRequired: false,
    budgets: { maxAttempts: 1, maxModelTokens: null, maxCostUsd: null, timeoutSeconds: 600 },
    blockReason: null,
    publishedRevision: null,
    createdAt: at,
    updatedAt: at,
  };
}

async function factsForUnit(options: PipelineOptions, unit: AnalysisUnit, attempt: number): Promise<{ toolDeps: ToolBuildDeps; facts: MockFacts } | null> {
  const inventory = options.state.inventory;
  if (inventory === null || options.state.bridge === null) return null;
  const task = syntheticAnalystTask(unit);
  const context = toolContextFor(options, task, options.signal, (detail) =>
    options.machine.record(unit.id, "policy_denied", detail),
  );
  const toolDeps: ToolBuildDeps = {
    context,
    task,
    unitId: unit.id,
    unitSourcePaths: unit.sourcePaths,
    unitGeneratedOutputs: unit.generatedOutputs.map((output) => output.path),
    converterDiagnostics: [],
    inventory,
  };
  const sourceFiles = [];
  for (const path of unit.sourcePaths) sourceFiles.push(await readUnitSource(options.workspace.paths.source, path));
  const portFiles: Record<string, string> = {};
  for (const output of unit.generatedOutputs) {
    const absolute = join(options.workspace.paths.port, output.path);
    if (existsSync(absolute)) portFiles[output.path] = readFileSync(absolute, "utf8");
  }
  const dependencies = options.state.dependencies;
  const hazards = options.state.hazards.filter((hazard) => hazard.unitId === unit.id);
  const diagnostics = diagnosticsForUnit(readConversionDiagnostics(options.workspace.paths.baseline), unit.sourcePaths);
  const facts: MockFacts = {
    unit,
    baselineId: options.state.baselineId,
    sourceSnapshotId: readSnapshotRecord(options.workspace.paths.evidenceInventory).snapshotId,
    sourceFiles,
    generatedOutputs: unit.generatedOutputs.map((output) => ({ path: output.path, sha256: output.sha256 })),
    converterDiagnostics: diagnostics,
    dependencies: dependencies ?? { edges: [], apiUsage: [], unresolved: [] },
    hazards,
    apiUsage: (dependencies?.apiUsage ?? []).filter((usage) => usage.unitId === unit.id),
    unresolved: (dependencies?.unresolved ?? []).filter((entry) => entry.unitId === unit.id),
    risk: { level: "low", reasons: [] },
    strategy: "retain_generated",
    contractVersions: {},
    writeAllowlist: unit.generatedOutputs.map((output) => output.path),
    portFiles,
    attempt,
  };
  return { toolDeps, facts };
}

export async function phaseAnalyze(
  options: PipelineOptions,
  state: PipelineState,
  contexts: Map<string, { toolDeps: ToolBuildDeps; facts: MockFacts }>,
  blocked: string[],
  failed: string[],
  skipped: string[],
): Promise<void> {
  const { workspace, repo } = options;
  const inventory = state.inventory ?? readInventory(workspace.paths.evidenceInventory);
  state.inventory = inventory;
  const bridge = state.bridge ?? readBridgeInventory(workspace.paths.evidenceInventory);
  state.bridge = bridge;
  const gmlApiEntries = state.gmlApi.length > 0 ? state.gmlApi : readGmlApiEntries(workspace.paths.evidenceInventory);
  state.gmlApi = gmlApiEntries;

  const dependencies = buildDependencies({
    snapshotDir: workspace.paths.source,
    units: inventory.units,
    bridge,
    gmlApiEntries,
  });
  state.dependencies = dependencies;
  const graph = buildGraph(inventory.units, dependencies);
  const groups = findGroups(graph, inventory.units);
  const units = applyGroups(inventory.units, groups);
  state.units = units;
  state.hazards = hazardsFromApiUsage(dependencies, units);
  for (const unit of units) {
    repo.upsertUnit({
      id: unit.id,
      kind: unit.kind,
      name: unit.name,
      analysisRequired: unit.analysisRequired,
      deterministic: !unit.analysisRequired,
      state: "DISCOVERED",
      sourceHashes: { ...unit.sourceHashes },
    });
    if (groups.some((group) => group.kind === "cycle" && group.unitIds.includes(unit.id))) {
      repo.setUnitGroup(unit.id, groups.find((group) => group.unitIds.includes(unit.id))?.id ?? null);
    }
  }

  const runtimeBundle = runtimeFor(options, contexts as Map<string, { toolDeps: ToolBuildDeps; facts: MockFacts }>);
  const cache = new AnalysisCache(repo);
  const machine = new TaskMachine(repo);
  const toAnalyze = units.filter((unit) => unit.analysisRequired);
  const sources: { path: string; source: string }[] = [];
  for (const unit of units) {
    for (const path of unit.sourcePaths) {
      if (path.endsWith(".gml")) sources.push({ path, source: readFileSync(join(workspace.paths.source, path), "utf8") });
    }
  }
  const macros = collectMacros(sources);

  const items: DispatchItem<AnalysisRecord>[] = [];
  for (const unit of toAnalyze) {
    const prepared = await factsForUnit(options, unit, 1);
    if (prepared === null) {
      skipped.push(`${unit.id}: unit facts could not be assembled`);
      continue;
    }
    contexts.set(unit.id, prepared);
    const edges = dependencies.edges.filter((edge) => edge.from === unit.id);
    const key = analysisCacheKey({
      unitId: unit.id,
      sourceHashes: unit.sourceHashes,
      dependencyEdges: edges.map((edge) => ({ to: edge.to, kind: edge.kind, contractVersions: {} })),
      baselineId: state.baselineId,
      gm2godotVersion: state.probe?.gm2godotVersion ?? null,
      godotVersion: workspace.config.godot.expectedVersion,
      promptVersion: ROLE_CONFIGS.analyst.resultTool,
      model: workspace.config.agent.model,
    });
    items.push({
      id: unit.id,
      run: async (signal) => {
        const cached = cache.get(key);
        if (cached !== null) {
          return cached.value as AnalysisRecord;
        }
        const request = {
          role: "analyst" as const,
          taskId: unit.id,
          systemPrompt: analystSystemPromptFor(options, unit, dependencies),
          userPrompt: analystUserPromptFor(unit),
          tools: buildToolSpecs("analyst", prepared.toolDeps),
          workspaceRoots: prepared.toolDeps.context.workspaceRoots,
          allowlist: prepared.toolDeps.context.allowlist,
          resultSchema: ROLE_CONFIGS.analyst.resultSchema,
          maxTurns: ROLE_CONFIGS.analyst.maxTurns,
          timeoutSeconds: ROLE_CONFIGS.analyst.defaultTimeoutSeconds,
          budgets: { tokens: workspace.config.agent.budgets.perTaskTokens, costUsd: workspace.config.agent.budgets.perTaskCostUsd },
          signal,
          credentials: runtimeBundle.credentials,
          attempt: 1,
          logger: options.logger,
          recordPolicyDenial: (detail: { tool: string; reason: string; path?: string }) => machine.record(unit.id, "policy_denied", detail),
        };
        const result = await runtimeBundle.runtime.run(request);
        if (result.outcome !== "completed" || result.result === undefined) {
          throw new DeepError("GM2DEEP-ANALYSIS-UNPRODUCED", `analysis of ${unit.id} produced no result: ${result.outcome}`, {
            outcome: result.outcome,
            reason: result.reason ?? null,
          });
        }
        const record = assembleAnalysis(options, unit, result.result as Record<string, unknown>, producedByFor(options, result.usage));
        validateAnalysisEvidence(record, inventory, { snapshotDir: workspace.paths.source });
        writeAnalysis(workspace.paths.evidenceAnalyses, record);
        repo.upsertAnalysis({
          unitId: unit.id,
          path: analysisPathFor(workspace.paths.evidenceAnalyses, unit.id),
          sha256: "",
          schemaVersion: 1,
          riskLevel: null,
          strategy: record.strategy,
          producedBy: record.producedBy,
        });
        cache.put(key, unit.id, "analysis", record);
        return record;
      },
    });
  }

  const outcomes = await dispatchAll(items, {
    maxWorkers: workspace.config.concurrency.analysis,
    leases: options.leases,
    budget: options.budget,
    logger: options.logger,
    signal: options.signal,
    canDispatch: () => ({ allowed: true, reason: null }),
    onSettled: async (outcome) => {
      if (outcome.skippedReason !== null) skipped.push(`${outcome.id}: ${outcome.skippedReason}`);
      if (!outcome.ok && outcome.error !== null) failed.push(`${outcome.id}: ${String(outcome.error)}`);
      if (outcome.ok) repo.setUnitState(outcome.id, "ANALYZED");
    },
  });
  const problematic = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.id);
  for (const unitId of problematic) {
    const unit = units.find((candidate) => candidate.id === unitId);
    if (unit !== undefined) {
      repo.setUnitState(unitId, "BLOCKED");
      machine.transition(unitId, "BLOCKED", { detail: { reason: "analysis did not complete" }, eventKind: "analysis_blocked" }).valueOf();
    }
  }

  // Risk and review pass.
  const analyses = new Map(listAnalyses(workspace.paths.evidenceAnalyses).map((record) => [record.unitId, record]));
  const sharedInterface = new Set(dependencies.edges.filter((edge) => edge.confidence === "confirmed" && edge.kind !== "shared_state").map((edge) => edge.to));
  for (const unit of units) {
    if (!unit.analysisRequired) continue;
    const record = analyses.get(unit.id);
    if (record === undefined) continue;
    const risk = riskScore({
      unitId: unit.id,
      record,
      review: null,
      edges: dependencies.edges.filter((edge) => edge.from === unit.id),
      dependents: dependencies.edges.filter((edge) => edge.to === unit.id).map((edge) => edge.from),
      inCycle: groups.some((group) => group.kind === "cycle" && group.unitIds.includes(unit.id)),
      ownsContractRule: sharedInterface.has(unit.id),
      unresolvedFeedsResourceIdentity: record.dependencies.unresolved.some((entry) => /asset_get_index|script_execute/.test(entry.symbol)),
    });
    repo.setUnitRisk(unit.id, risk);
    if (!strategyIsJustified(record)) {
      options.logger.warn(`analysis for ${unit.id} chose ${record.strategy} without a sufficient rationale`);
    }
    const trigger = reviewRequired({
      risk,
      ownsSharedInterface: sharedInterface.has(unit.id),
      contractChanged: false,
      requireReviewFor: workspace.config.policy.requireReviewFor,
      hasUncertainties: record.uncertainties.length > 0,
      contradictsDependency: false,
    });
    if (!trigger.required) continue;
    const prepared = contexts.get(unit.id);
    if (prepared === undefined) continue;
    const reviewRequest = {
      role: "risk_reviewer" as const,
      taskId: `${unit.id}#review`,
      systemPrompt: `Review the analyst record for ${unit.id}. Prompt version ${PROMPT_VERSION}.`,
      userPrompt: JSON.stringify(record).slice(0, 60_000),
      tools: buildToolSpecs("risk_reviewer", prepared.toolDeps),
      workspaceRoots: prepared.toolDeps.context.workspaceRoots,
      allowlist: prepared.toolDeps.context.allowlist,
      resultSchema: ROLE_CONFIGS.risk_reviewer.resultSchema,
      maxTurns: ROLE_CONFIGS.risk_reviewer.maxTurns,
      timeoutSeconds: ROLE_CONFIGS.risk_reviewer.defaultTimeoutSeconds,
      budgets: { tokens: null, costUsd: null },
      signal: options.signal,
      credentials: runtimeBundle.credentials,
      attempt: 1,
      logger: options.logger,
      recordPolicyDenial: (detail: { tool: string; reason: string; path?: string }) => machine.record(unit.id, "policy_denied", detail),
    };
    const reviewResult = await runtimeBundle.runtime.run(reviewRequest);
    if (reviewResult.outcome !== "completed" || reviewResult.result === undefined) {
      skipped.push(`${unit.id}: risk review did not complete (${reviewResult.outcome})`);
      continue;
    }
    const review: ReviewRecord = {
      ...(reviewResult.result as Omit<ReviewRecord, "schemaVersion" | "unitId" | "producedBy">),
      schemaVersion: 1,
      unitId: unit.id,
      producedBy: producedByFor(options, reviewResult.usage),
    };
    writeReview(workspace.paths.evidenceAnalyses, review);
    const refuted = review.challenges.filter((challenge) => challenge.verdict === "refuted");
    if (refuted.length > 0) {
      repo.recordInvalidation({ kind: "review_contradiction", unitId: unit.id, detail: refuted });
      options.logger.warn(`review refuted ${refuted.length} claim(s) of ${unit.id}; escalated to the reconciler`);
    }
  }
}

function analystSystemPromptFor(options: PipelineOptions, unit: AnalysisUnit, dependencies: { edges: readonly { from: string; to: string; kind: string }[] }): string {
  const edges = dependencies.edges.filter((edge) => edge.from === unit.id).map((edge) => `${edge.kind}->${edge.to}`);
  return [
    `Prompt version ${PROMPT_VERSION}. Role: analyst.`,
    "The source files are authoritative; summaries and the generated Godot output are navigation aids.",
    "Never guess: record dynamic lookups as uncertainties or unresolved references.",
    "Every claim must cite a path, sha256 and line you actually read.",
    `Unit ${unit.id} (kind ${unit.kind}). Recorded outgoing edges: ${edges.join(", ") || "none"}.`,
    `Write allowlist for this task: none. You have no shell and no write tool.`,
  ].join("\n");
}

function analystUserPromptFor(unit: AnalysisUnit): string {
  return [
    `Analyse unit ${unit.id}.`,
    `Source files: ${unit.sourcePaths.join(", ")}`,
    unit.generatedOutputs.length === 0
      ? "Generated Godot output for this unit: none recorded."
      : `Generated Godot output for this unit: ${unit.generatedOutputs.map((output) => output.path).join(", ")}`,
  ].join("\n");
}

function assembleAnalysis(
  options: PipelineOptions,
  unit: AnalysisUnit,
  payload: Record<string, unknown>,
  producedBy: ProducedBy,
): AnalysisRecord {
  const inventory = options.state.inventory;
  const snapshot = readSnapshotRecord(options.workspace.paths.evidenceInventory);
  const diagnostics: ConverterDiagnostic[] = diagnosticsForUnit(
    readConversionDiagnostics(options.workspace.paths.baseline),
    unit.sourcePaths,
  );
  void inventory;
  return {
    ...(payload as Omit<AnalysisRecord, "schemaVersion" | "unitId" | "unitKind" | "sourceSnapshotId" | "baselineId" | "generatedOutputs" | "producedBy">),
    schemaVersion: 1,
    unitId: unit.id,
    unitKind: unit.kind,
    sourceSnapshotId: snapshot.snapshotId,
    baselineId: options.state.baselineId,
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
    converterDiagnostics: diagnostics,
    producedBy,
  };
}

export { assembleAnalysis, factsForUnit, syntheticAnalystTask };
