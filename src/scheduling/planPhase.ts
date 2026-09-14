/**
 * Phase orchestration: analyze → plan → implement → validate → report.
 *
 * Every phase receives the single {@link PipelineRun} context, so no phase ever reaches for a collaborator
 * that was not handed to it. Identity and provenance fields on every artifact written here are host-owned:
 * a model describes what it found, never who it is or what it ran against.
 */

import { ZERO_USAGE } from "../agents/runtime.ts";
import {
  latestPlanVersion,
  listAnalyses,
  listContracts,
  readPlan,
  readReview,
} from "../evidence/store.ts";
import { readInventory } from "../indexing/inventory.ts";
import { seedContracts } from "../planning/contracts.ts";
import { reconcile } from "../planning/reconciler.ts";
import { planTasks } from "../planning/tasks.ts";
import { DeepError } from "../util/result.ts";
import { MOCK_USAGE, producedByFor, type PipelineRun } from "./pipeline.ts";

import { syntheticTask, turnBudget, unitContextFor } from "./phaseContext.ts";

export async function phasePlan(run: PipelineRun): Promise<void> {
  const { workspace, repo } = run.options;
  const state = run.state;
  const inventory =
    state.inventory ?? readInventory(workspace.paths.evidenceInventory);
  state.inventory = inventory;
  if (state.units.length === 0) state.units = inventory.units;
  if (state.dependencies === null) {
    throw new DeepError(
      "GM2DEEP-ANALYZE-MISSING",
      "the dependency graph must be built before planning",
    );
  }
  state.analyses = new Map(
    listAnalyses(workspace.paths.evidenceAnalyses).map((record) => [
      record.unitId,
      record,
    ]),
  );
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
      {
        id: "reconcile",
        kind: "project_settings",
        name: "reconcile",
        sourcePaths: [],
        sourceHashes: {},
        generatedOutputs: [],
        analysisRequired: false,
      },
      1,
    ),
  );

  const existingVersion = latestPlanVersion(workspace.paths.evidencePlans);
  if (run.options.reusePlan && existingVersion !== null) {
    state.plan = readPlan(workspace.paths.evidencePlans, existingVersion);
    state.contracts = listContracts(workspace.paths.evidenceContracts);
    run.options.logger.info(`plan: reusing reviewed v${existingVersion}`);
    return;
  }
  const missing = state.units.filter(
    (unit) => unit.analysisRequired && !state.analyses.has(unit.id),
  );
  if (missing.length) run.budget.assertNotExceeded(null);
  if (missing.length)
    throw new DeepError(
      "GM2DEEP-RESEARCH-INCOMPLETE",
      `${missing.length} units have no validated research; resume research before planning`,
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
    producedBy: producedByFor(
      run.options,
      run.runtime.simulated ? MOCK_USAGE : ZERO_USAGE,
    ),
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
      .filter((review) =>
        review.challenges.some((challenge) => challenge.verdict === "refuted"),
      )
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
      const contract = outcome.contracts.find(
        (candidate) => candidate.concern === concern,
      );
      if (contract === undefined) continue;
      for (const rule of contract.rules) {
        for (const unitId of draft.unitIds)
          repo.bindContractRule(concern, version, unitId, rule.id);
      }
    }

    const existing = repo.getTask(draft.id);
    if (existing !== null) {
      // Re-planning must never destroy progress: an ACCEPTED task stays accepted, and a task that is
      // mid-flight is left for `resume`. Only a task still at PLANNED is advanced.
      if (existing.state === "PLANNED") {
        if (blockReason === null) {
          run.machine.transition(draft.id, "READY", {
            detail: { strategy: draft.strategy, unitIds: draft.unitIds },
          });
        } else {
          repo.setTaskBlockReason(draft.id, blockReason);
          run.machine.transition(draft.id, "BLOCKED", {
            detail: { reason: blockReason },
          });
          run.blocked.push(`${draft.id}: ${blockReason}`);
        }
      } else if (existing.inputHash !== draft.inputHash) {
        repo.recordInvalidation({
          kind: "task_input_changed",
          unitId: draft.unitIds[0] ?? draft.id,
          detail: {
            taskId: draft.id,
            state: existing.state,
            recorded: existing.inputHash,
            planned: draft.inputHash,
          },
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
      run.machine.transition(draft.id, "READY", {
        detail: { strategy: draft.strategy, unitIds: draft.unitIds },
      });
      for (const unitId of draft.unitIds) repo.setUnitState(unitId, "PLANNED");
    } else {
      repo.setTaskBlockReason(draft.id, blockReason);
      run.machine.transition(draft.id, "BLOCKED", {
        detail: { reason: blockReason },
      });
      run.blocked.push(`${draft.id}: ${blockReason}`);
      for (const unitId of draft.unitIds) repo.setUnitState(unitId, "BLOCKED");
    }
  }

  for (const retained of drafts.retained) {
    const before = repo.getUnit(retained.unitId);
    repo.setUnitStrategy(retained.unitId, "retain_generated");
    if (before?.state !== "ACCEPTED")
      repo.setUnitState(retained.unitId, "ACCEPTED");
    if (before?.strategy !== "retain_generated") {
      repo.recordInvalidation({
        kind: "retained_unit",
        unitId: retained.unitId,
        detail: { reason: retained.reason },
      });
    }
  }
  run.options.onProgress?.({
    phase: "plan",
    tasks: drafts.tasks.length,
    retained: drafts.retained.length,
    blocked: drafts.blocked.length,
  });
  run.options.logger.info(
    `plan: ${String(drafts.tasks.length)} task(s), ${String(drafts.retained.length)} retained unit(s), ${String(drafts.blocked.length)} blocked`,
  );
}
