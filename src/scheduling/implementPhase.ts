import { emitImplementationTasks } from "./progress.ts";
import { orderTasks } from "./taskOrder.ts";
/**
 * Phase orchestration: analyze → plan → implement → validate → report.
 *
 * Every phase receives the single {@link PipelineRun} context, so no phase ever reaches for a collaborator
 * that was not handed to it. Identity and provenance fields on every artifact written here are host-owned:
 * a model describes what it found, never who it is or what it ran against.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { implementerSystemPrompt } from "../agents/prompts.ts";
import { ROLE_CONFIGS } from "../agents/roles.ts";
import {
  buildToolSpecs,
  validateProposedPatch,
  type ImplementerSubmission,
} from "../agents/toolSpecs.ts";
import { encodeId } from "../evidence/ids.ts";
import type { PatchRecordPayload } from "../evidence/schemas.ts";
import {
  patchDiffPath,
  patchJsonPath,
  preimagesForRoot,
  renderUnifiedDiff,
} from "../integration/diff.ts";
import { integrateTask } from "../integration/integrator.ts";
import { patchPayloadSha256 } from "../integration/publish.ts";
import type { TaskRecord } from "../storage/types.ts";
import { newId } from "../util/ids.ts";
import { ensureDir, writeJsonAtomic, writeTextAtomic } from "../util/json.ts";
import { repoRoot } from "../util/package.ts";
import { DeepError } from "../util/result.ts";
import { checkBehavioral } from "../validation/behavioral.ts";
import {
  persistValidation,
  skippedResult,
  type ValidationResult,
} from "../validation/levels.ts";
import { checkStructural } from "../validation/structural.ts";
import { ensurePort, producedByFor, type PipelineRun } from "./pipeline.ts";
import { decideModelRetry, decideRepair } from "./retry.ts";

import { turnBudget, unitContextFor, unitForTask } from "./phaseContext.ts";

interface RunChecksInput {
  readonly run: PipelineRun;
  readonly task: TaskRecord;
  readonly attempt: number;
}

async function runCandidateChecks(
  input: RunChecksInput,
  candidateDir: string,
): Promise<readonly ValidationResult[]> {
  const { run, task, attempt } = input;
  const { workspace } = run.options;
  const safe = encodeId(task.id);
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
    reportDir: ensureDir(
      join(
        workspace.paths.validation,
        safe,
        `attempt-${String(attempt)}`,
        "reports",
      ),
    ),
    inputRevision,
    repoRoot,
    expectedGodot,
  });
  const behavioral = await behavioralCheck(run, {
    candidateProjectDir: candidateDir,
    workspaceValidationDir: join(
      workspace.paths.validation,
      `${safe}-attempt-${String(attempt)}`,
    ),
    checkId: `candidate-behavioral:${safe}:attempt-${String(attempt)}`,
    inputRevision,
  });
  const renamed = [...structural, behavioral].map((check) => ({
    ...check,
    checkId: `candidate-${safe}-${check.checkId}`,
  }));
  persistValidation(
    {
      dir: workspace.paths.evidenceValidation,
      repo: run.repo,
      taskId: task.id,
    },
    renamed,
  );
  return renamed;
}

interface BehavioralInput {
  readonly candidateProjectDir: string;
  readonly workspaceValidationDir: string;
  readonly checkId: string;
  readonly inputRevision: string;
}

/** Level D against the shipped scenario and recorded expectation; `skipped` when either is absent. */
export async function behavioralCheck(
  run: PipelineRun,
  input: BehavioralInput,
): Promise<ValidationResult> {
  const { workspace } = run.options;
  const scenario = join(repoRoot, "fixtures", "scenarios", "counter_trace.gd");
  const expected = join(
    repoRoot,
    "fixtures",
    "traces",
    "counter_expected.json",
  );
  const identity = {
    level: "D" as const,
    checkId: input.checkId,
    name: "level D behavioural — scenario trace comparison",
    inputRevision: input.inputRevision,
  };
  const fixtureProject = resolve(
    repoRoot,
    "fixtures",
    "gm-projects",
    "counter",
  );
  if (resolve(workspace.config.source.path) !== fixtureProject) {
    return skippedResult({
      ...identity,
      reason: `no project-specific behavioral expectation is recorded for source ${workspace.config.source.path}; shipped counter scenario is restricted to ${fixtureProject}`,
    });
  }
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
  emitImplementationTasks(run);
  const filter = new Set(run.options.taskFilter);
  let tasks = orderTasks([
    ...repo.listTasksInState("READY"),
    ...repo.listTasksInState("REPAIR_REQUIRED"),
  ]);
  if (filter.size > 0) tasks = tasks.filter((task) => filter.has(task.id));
  if (tasks.length === 0) {
    run.options.logger.info("implement: no READY task to run");
    return;
  }

  for (const initial of tasks) {
    run.options.signal.throwIfAborted();
    const unmet = initial.dependsOn.filter(
      (id) => repo.getTask(id)?.state !== "ACCEPTED",
    );
    if (unmet.length) {
      run.blocked.push(
        `${initial.id}: prerequisites not accepted: ${unmet.join(", ")}`,
      );
      continue;
    }
    let task = initial;
    let repairAttempts = 0;
    const diagnosis: string[] = [];
    for (;;) {
      run.options.signal.throwIfAborted();
      run.machine.transition(task.id, "RUNNING", { incrementAttempt: true });
      task = repo.getTask(task.id) ?? task;
      const unit = unitForTask(task, state.units);
      run.contexts.set(task.id, unitContextFor(run, task, unit, task.attempt));
      const prepared = run.contexts.get(task.id);
      if (prepared === undefined)
        throw new DeepError(
          "GM2DEEP-RUNTIME-CONTEXT-MISSING",
          `no context for ${task.id}`,
        );
      const budget = turnBudget(workspace.config, "implementer");
      const result = await run.runtime.run({
        role: "implementer",
        taskId: task.id,
        systemPrompt: implementerSystemPrompt({
          contracts: state.contracts,
          dependencySummary: `${task.unitIds.join(", ")}; write allowlist ${task.allowlist.write.join(", ") || "none"}`,
          ...(diagnosis.length === 0
            ? {}
            : { extra: `Previous attempt failed:\n${diagnosis.join("\n")}` }),
        }),
        userPrompt: [
          `Produce the patch for task ${task.id} (strategy ${task.strategy}).`,
          `Units: ${task.unitIds.join(", ")}`,
          `Write allowlist: ${task.allowlist.write.join(", ") || "none"}`,
          "Reviewed unit research and conversion instructions:",
          JSON.stringify(
            task.unitIds.map(
              (id) => state.analyses.get(id) ?? { unitId: id, missing: true },
            ),
          ),
          ...(diagnosis.length === 0
            ? []
            : [
                "",
                "Failing evidence from the previous attempt:",
                ...diagnosis,
              ]),
        ].join("\n"),
        tools: buildToolSpecs("implementer", prepared.toolDeps),
        workspaceRoots: prepared.toolDeps.context.workspaceRoots,
        allowlist: prepared.toolDeps.context.allowlist,
        resultSchema: ROLE_CONFIGS.implementer.resultSchema,
        maxTurns: budget.maxTurns,
        timeoutSeconds: budget.timeoutSeconds,
        budgets: {
          tokens: task.budgets.maxModelTokens,
          costUsd: task.budgets.maxCostUsd,
        },
        signal: run.options.signal,
        credentials: run.credentials,
        attempt: task.attempt,
        logger: run.options.logger,
        recordPolicyDenial: (detail) =>
          run.machine.record(task.id, "policy_denied", detail),
      });

      if (result.outcome !== "completed" || result.result === undefined) {
        run.machine.record(task.id, "failure", {
          reason: result.reason ?? result.outcome,
          outcome: result.outcome,
        });
        run.machine.transition(task.id, "FAILED", {
          detail: { reason: result.reason ?? result.outcome },
        });
        const decision = decideModelRetry(task, [
          result.reason ?? result.outcome,
        ]);
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
        producedBy: producedByFor(run.options, result.usage, result.provenance),
      };
      try {
        validateProposedPatch(task, submission);
      } catch (error) {
        const reason =
          error instanceof DeepError
            ? `${error.code}: ${error.message}`
            : String(error);
        run.machine.record(task.id, "failure", {
          reason,
          outcome: "invalid_patch",
        });
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

      const jsonPath = patchJsonPath(
        workspace.paths.evidencePatches,
        task.id,
        task.attempt,
      );
      const diffPath = patchDiffPath(
        workspace.paths.evidencePatches,
        task.id,
        task.attempt,
      );
      writeJsonAtomic(jsonPath, payload);
      writeTextAtomic(
        diffPath,
        renderUnifiedDiff(payload, {
          preimages: preimagesForRoot(port, payload),
        }),
      );
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
      run.machine.transition(task.id, "IMPLEMENTED", {
        detail: { patchSha256, patchId },
      });
      run.machine.transition(task.id, "VALIDATING", {
        detail: { patchId, attempt: task.attempt },
      });

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
        runChecks: (candidateDir) =>
          runCandidateChecks(
            { run, task, attempt: task.attempt },
            candidateDir,
          ),
        contracts: state.contracts,
        tools: buildToolSpecs("patch_reviewer", {
          ...prepared.toolDeps,
          context: { ...prepared.toolDeps.context, role: "patch_reviewer" },
        }),
        logger: run.options.logger,
        recordPolicyDenial: (detail) =>
          run.machine.record(task.id, "policy_denied", detail),
        portMutex: run.portMutex,
      });

      const failedChecks = outcome.checks.filter(
        (check) => check.state === "failed",
      );
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
          detail: {
            revision: outcome.revision,
            integrationId: outcome.integrationId,
            patchSha256,
          },
        });
        if (outcome.revision !== null)
          repo.setTaskPublishedRevision(task.id, outcome.revision);
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
        for (const unitId of task.unitIds)
          repo.setUnitState(unitId, "ACCEPTED");
        run.options.logger.info(
          `implement: ${task.id} accepted at port revision ${String(outcome.revision)}`,
        );
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
      const failing = failedChecks.map(
        (check) => `${check.level}:${check.checkId}`,
      );
      const repair = decideRepair(
        repairAttempts,
        {
          maxTaskAttempts: task.maxAttempts,
          maxRepairAttempts: workspace.config.policy.maxRepairAttempts,
        },
        failing.length > 0 ? failing : outcome.reasons,
      );
      run.machine.record(task.id, "repair", {
        repairAttempt: repair.repairAttempt,
        decision: repair.action,
        failingChecks: failing,
      });
      diagnosis.push(
        ...outcome.reasons,
        ...failedChecks.map(
          (check) =>
            `level ${check.level} ${check.checkId}: ${check.reason ?? ""}`,
        ),
      );
      if (repair.action === "repair") {
        run.machine.transition(task.id, "REPAIR_REQUIRED", {
          detail: { reason: repair.reason },
        });
        repairAttempts = repair.repairAttempt;
        task = repo.getTask(task.id) ?? task;
        continue;
      }
      run.machine.transition(task.id, "BLOCKED", {
        detail: { reason: repair.reason },
      });
      repo.setTaskBlockReason(task.id, repair.reason);
      run.blocked.push(`${task.id}: ${repair.reason}`);
      break;
    }
  }
}
