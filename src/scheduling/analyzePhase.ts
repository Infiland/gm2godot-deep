import { recoveryError } from "./recovery.ts";
import { roleAgentConfig } from "../agents/factory.ts";
import { canonicalJson } from "../util/json.ts";
/**
 * Phase orchestration: analyze → plan → implement → validate → report.
 *
 * Every phase receives the single {@link PipelineRun} context, so no phase ever reaches for a collaborator
 * that was not handed to it. Identity and provenance fields on every artifact written here are host-owned:
 * a model describes what it found, never who it is or what it ran against.
 */

import {
  diagnosticsForUnit,
  readConversionDiagnostics,
} from "../adapters/gm2godot/diagnostics.ts";
import {
  PROMPT_VERSION,
  analystSystemPrompt,
  analystUserPrompt,
} from "../agents/prompts.ts";
import { ROLE_CONFIGS } from "../agents/roles.ts";
import { buildToolSpecs } from "../agents/toolSpecs.ts";
import { findGroups } from "../analysis/cycles.ts";
import { buildDependencies } from "../analysis/dependencies.ts";
import { buildGraph } from "../analysis/graph.ts";
import { hazardsFromApiUsage } from "../analysis/hazards.ts";
import type {
  AnalysisRecord,
  ProducedBy,
  ReviewRecord,
} from "../evidence/schemas.ts";
import {
  analysisPathFor,
  listAnalyses,
  writeAnalysis,
  writeReview,
} from "../evidence/store.ts";
import {
  readBridgeInventory,
  readGmlApiEntries,
  readInventory,
  readSnapshotRecord,
} from "../indexing/inventory.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import {
  contradictionBetween,
  reviewRequired,
  riskScore,
  strategyIsJustified,
} from "../planning/risk.ts";
import { DeepError } from "../util/result.ts";
import { sha256Bytes } from "../util/sha256.ts";
import { analysisCacheKey } from "./cache.ts";
import { producedByFor, type PipelineRun } from "./pipeline.ts";
import { dispatchAll, type DispatchItem } from "./scheduler.ts";

import {
  syntheticAnalystTask,
  turnBudget,
  unitContextFor,
} from "./phaseContext.ts";

export async function phaseAnalyze(run: PipelineRun): Promise<void> {
  const { workspace, repo } = run.options;
  const state = run.state;
  const inventory =
    state.inventory ?? readInventory(workspace.paths.evidenceInventory);
  state.inventory = inventory;
  const bridge =
    state.bridge ?? readBridgeInventory(workspace.paths.evidenceInventory);
  state.bridge = bridge;
  state.gmlApi =
    state.gmlApi.length > 0
      ? state.gmlApi
      : readGmlApiEntries(workspace.paths.evidenceInventory);
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
    const group = state.groups.find(
      (candidate) =>
        candidate.kind === "cycle" && candidate.unitIds.includes(unit.id),
    );
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
    const prepared = unitContextFor(
      run,
      syntheticAnalystTask(
        unit,
        inventory.files
          .filter((f) => f.classification !== "excluded")
          .map((f) => f.path),
      ),
      unit,
      1,
    );
    run.contexts.set(unit.id, prepared);
    const edges = dependencies.edges.filter((edge) => edge.from === unit.id);
    const key = analysisCacheKey({
      unitId: unit.id,
      sourceHashes: unit.sourceHashes,
      dependencyEdges: edges.map((edge) => ({
        to: edge.to,
        kind: edge.kind,
        contractVersions: {},
      })),
      baselineId: state.baselineId,
      gm2godotVersion: state.probe?.gm2godotVersion ?? null,
      godotVersion: workspace.config.godot.expectedVersion,
      promptVersion: PROMPT_VERSION,
      model:
        workspace.config.host?.researchModelIdentity ??
        canonicalJson({
          runtime: workspace.config.agent.runtime,
          provider: workspace.config.agent.provider,
          model: workspace.config.agent.model,
          roles: workspace.config.agent.roleOverrides,
          freeOnly: workspace.config.agent.freeOnly,
        }),
    });
    cacheKeys.set(unit.id, key);
    items.push({
      id: unit.id,
      run: async (signal): Promise<AnalysisRecord> => {
        const cached = run.cache.get(key);
        if (cached !== null) {
          const record = cached.value as AnalysisRecord;
          const written = writeAnalysis(
            workspace.paths.evidenceAnalyses,
            record,
          );
          repo.upsertAnalysis({
            unitId: unit.id,
            path: analysisPathFor(workspace.paths.evidenceAnalyses, unit.id),
            sha256: written.sha256,
            schemaVersion: 1,
            riskLevel: null,
            strategy: record.strategy,
            producedBy: record.producedBy,
          });
          run.options.logger.debug(
            `analyze: reused cached analysis for ${unit.id}`,
          );
          return record;
        }
        const budget = turnBudget(workspace.config, "analyst");
        const result = await run.runtime.run({
          role: "analyst",
          taskId: unit.id,
          systemPrompt: analystSystemPrompt({
            contracts: [],
            dependencySummary:
              edges
                .map((edge) => `${edge.kind}->${edge.to} (${edge.confidence})`)
                .join(", ") || "no outgoing edges recorded",
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
            run.repo.recordInvalidation({
              kind: "policy_denied",
              unitId: unit.id,
              detail,
            }),
        });

        if (result.outcome !== "completed" || result.result === undefined) {
          throw new DeepError(
            "GM2DEEP-ANALYSIS-UNPRODUCED",
            `analysis of ${unit.id} produced no result: ${result.outcome}`,
            {
              unitId: unit.id,
              outcome: result.outcome,
              reason: result.reason ?? null,
            },
          );
        }
        const record = assembleAnalysis(
          run,
          unit,
          result.result as Record<string, unknown>,
          producedByFor(run.options, result.usage, result.provenance),
        );
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

  const selected = roleAgentConfig(workspace.config, "analyst");
  run.options.onProgress?.({
    phase: "tasks",
    tasks: state.units.map((unit) => ({
      taskId: unit.id,
      label: unit.name,
      phase: "research",
      role: "analyst",
      state: unit.analysisRequired ? "pending" : "skipped",
      attempt: 0,
      provider: selected.provider,
      model: selected.model,
      summary: unit.analysisRequired
        ? "Awaiting research"
        : "Accounted for by deterministic conversion",
    })),
  });
  let interrupted: Error | null = null;
  let completed = 0;
  let blocked = 0;
  run.options.onProgress?.({
    phase: "research",
    completed,
    total: toAnalyze.length,
    blocked,
  });
  const outcomes = await dispatchAll(items, {
    maxWorkers: run.options.maxWorkers ?? workspace.config.concurrency.analysis,
    ...(run.options.currentMaxWorkers
      ? { currentMaxWorkers: run.options.currentMaxWorkers }
      : {}),
    ...(workspace.config.host
      ? { stopOnError: (error: unknown) => recoveryError(error) !== null }
      : {}),
    leases: run.leases,
    budget: run.budget,
    logger: run.options.logger,
    signal: run.options.signal,
    canDispatch: () => ({ allowed: true, reason: null }),
    onSettled: async (outcome) => {
      if (outcome.skippedReason !== null)
        run.skipped.push(`${outcome.id}: ${outcome.skippedReason}`);
      const recovery = recoveryError(outcome.error);
      if (workspace.config.host && recovery) interrupted = recovery;
      if (!outcome.ok) {
        run.failed.push(`${outcome.id}: ${String(outcome.error)}`);
        run.options.onProgress?.({
          phase: "research",
          taskId: outcome.id,
          state: "failed",
          reason: outcome.skippedReason ?? String(outcome.error),
        });
      }
      if (outcome.ok) {
        repo.setUnitState(outcome.id, "ANALYZED");
        completed++;
      } else blocked++;
      run.options.onProgress?.({
        phase: "research",
        taskId: outcome.id,
        state: outcome.ok ? "completed" : recovery ? "paused" : "blocked",
        reason: outcome.ok
          ? null
          : (outcome.skippedReason ?? String(outcome.error)),
        ...(outcome.value
          ? {
              summary: [
                outcome.value.purpose.text,
                ...outcome.value.behavior.observed
                  .slice(0, 3)
                  .map((entry) => `Observed: ${entry.statement}`),
                ...outcome.value.behavior.inferred
                  .slice(0, 3)
                  .map((entry) => `Inferred: ${entry.statement}`),
              ]
                .join("\n")
                .slice(0, 4000),
              artifact: analysisPathFor(
                workspace.paths.evidenceAnalyses,
                outcome.id,
              ),
              provider: outcome.value.producedBy.provider ?? null,
              model: outcome.value.producedBy.model ?? null,
            }
          : { summary: "Research needs attention; progress is saved." }),
        completed,
        total: toAnalyze.length,
        blocked,
      });
    },
  });
  if (interrupted) throw interrupted;
  run.options.signal.throwIfAborted();
  run.budget.assertNotExceeded(null);
  for (const outcome of outcomes) {
    if (outcome.ok) continue;
    repo.setUnitState(outcome.id, "BLOCKED");
    const unit = state.units.find((candidate) => candidate.id === outcome.id);
    if (unit !== undefined) {
      repo.recordInvalidation({
        kind: "analysis_blocked",
        unitId: unit.id,
        detail: {
          reason:
            outcome.error === null
              ? outcome.skippedReason
              : String(outcome.error),
        },
      });
    }
  }

  // Risk and review pass over the analyses that actually landed on disk.
  state.analyses = new Map(
    listAnalyses(workspace.paths.evidenceAnalyses).map((record) => [
      record.unitId,
      record,
    ]),
  );
  const sharedInterface = new Set(
    dependencies.edges
      .filter(
        (edge) =>
          edge.confidence === "confirmed" && edge.kind !== "shared_state",
      )
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
    const dependencyRecord =
      dependencies.edges
        .filter(
          (edge) => edge.from === unit.id && edge.confidence !== "unresolved",
        )
        .map((edge) => state.analyses.get(edge.to) ?? null)
        .find((candidate): candidate is AnalysisRecord => candidate !== null) ??
      null;
    const contradiction = contradictionBetween(record, dependencyRecord);
    const risk = riskScore({
      unitId: unit.id,
      record,
      review: null,
      edges: dependencies.edges.filter((edge) => edge.from === unit.id),
      dependents: dependencies.edges
        .filter((edge) => edge.to === unit.id)
        .map((edge) => edge.from),
      inCycle: state.groups.some(
        (group) => group.kind === "cycle" && group.unitIds.includes(unit.id),
      ),
      ownsContractRule: sharedInterface.has(unit.id),
      unresolvedFeedsResourceIdentity: record.dependencies.unresolved.some(
        (entry) => /asset_get_index|script_execute/.test(entry.symbol),
      ),
    });
    repo.setUnitRisk(unit.id, risk);
    state.risks.set(unit.id, risk);
    if (!strategyIsJustified(record)) {
      run.options.logger.warn(
        `analysis for ${unit.id} chose ${record.strategy} without a sufficient rationale`,
      );
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
        run.repo.recordInvalidation({
          kind: "policy_denied",
          unitId: unit.id,
          detail,
        }),
    });

    if (
      reviewResult.outcome !== "completed" ||
      reviewResult.result === undefined
    ) {
      run.skipped.push(
        `${unit.id}: risk review did not complete (${reviewResult.outcome})`,
      );
      continue;
    }
    const review: ReviewRecord = {
      ...(reviewResult.result as Omit<
        ReviewRecord,
        "schemaVersion" | "unitId" | "producedBy"
      >),
      schemaVersion: 1,
      unitId: unit.id,
      producedBy: producedByFor(
        run.options,
        reviewResult.usage,
        reviewResult.provenance,
      ),
    };
    const written = writeReview(workspace.paths.evidenceAnalyses, review);
    run.cache.put(reviewKey, unit.id, "review", review);
    state.reviews.set(unit.id, review);
    repo.recordInvalidation({
      kind: "risk_review",
      unitId: unit.id,
      detail: { scenarios: written.sha256, reasons: trigger.reasons },
    });
    const refuted = review.challenges.filter(
      (challenge) => challenge.verdict === "refuted",
    );
    if (refuted.length > 0) {
      repo.recordInvalidation({
        kind: "review_contradiction",
        unitId: unit.id,
        detail: refuted,
      });
      run.options.logger.warn(
        `review refuted ${String(refuted.length)} claim(s) of ${unit.id}; escalated to planning`,
      );
    }
  }
  run.options.logger.info(
    `analyze: ${String(state.analyses.size)} analysis record(s) recorded`,
  );
}

function assembleAnalysis(
  run: PipelineRun,
  unit: AnalysisUnit,
  payload: Record<string, unknown>,
  producedBy: ProducedBy,
): AnalysisRecord {
  const snapshot = readSnapshotRecord(
    run.options.workspace.paths.evidenceInventory,
  );
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
      ...(output.sourceMapPath === null
        ? {}
        : { sourceMapPath: output.sourceMapPath }),
    })),
    converterDiagnostics: [...diagnostics],
    producedBy,
  };
}
