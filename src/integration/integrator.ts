import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContractRecord, PatchRecordPayload } from "../evidence/schemas.ts";
import type { AgentRunRequest, AgentRuntime, ToolContext, ToolSpec } from "../agents/runtime.ts";
import type { Repo } from "../storage/repo.ts";
import type { TaskRecord } from "../storage/types.ts";
import { canonicalJson } from "../util/json.ts";
import { DeepError } from "../util/result.ts";
import type { Logger } from "../util/log.ts";
import type { ValidationResult } from "../validation/levels.ts";
import { copyTree } from "../workspaces/staging.ts";
import { removeTree, type Workspace } from "../workspaces/workspace.ts";
import { validateProposedPatch, type ImplementerSubmission } from "../agents/toolSpecs.ts";
import { applyPatchToTree, preimagesForRoot, renderUnifiedDiff } from "./diff.ts";
import { integrationIdempotencyKey, patchPayloadSha256, publishPatch } from "./publish.ts";
import { reviewPatch, type PatchReviewVerdict } from "./review.ts";

export interface IntegrationDeps {
  readonly workspace: Workspace;
  readonly repo: Repo;
  readonly task: TaskRecord;
  readonly payload: PatchRecordPayload;
  /** Contract versions in effect right now; a mismatch means the patch was planned against another plan. */
  readonly currentContractVersions: Record<string, number>;
  readonly currentPortRevision: number;
  readonly expectedInputHash: string;
  /** The baseline id the patch was produced against, and the one the workspace holds now. */
  readonly baselineId: string;
  readonly currentBaselineId: string;
  readonly runtime: AgentRuntime;
  readonly workspaceRoots: AgentRunRequest["workspaceRoots"];
  readonly credentials: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly runChecks: (candidateDir: string) => Promise<readonly ValidationResult[]>;
  readonly contracts?: readonly ContractRecord[];
  readonly tools?: readonly ToolSpec[];
  readonly logger?: Logger;
  readonly recordPolicyDenial?: ToolContext["recordPolicyDenial"];
  /**
   * Single-writer mutex for `port/` and the port revision counter, owned by the scheduler. Publication
   * runs inside it so no two tasks can interleave a file write with a revision bump.
   */
  readonly portMutex?: <T>(body: () => Promise<T> | T) => Promise<T>;
}

export interface IntegrationOutcome {
  readonly state: "accepted" | "rejected";
  readonly reasons: readonly string[];
  readonly revision: number | null;
  readonly integrationId: string | null;
  readonly checks: readonly ValidationResult[];
  readonly review: PatchReviewVerdict | null;
}

function rejected(
  reasons: readonly string[],
  checks: readonly ValidationResult[] = [],
  review: PatchReviewVerdict | null = null,
): IntegrationOutcome {
  return { state: "rejected", reasons, revision: null, integrationId: null, checks, review };
}

/**
 * The inputs a patch must still be valid against: the plan's contract versions, the unit input hash the
 * task was created with, and the baseline id whose generated output the patch edits. Any drift makes the
 * patch stale — it is re-planned, never applied to a tree it was not derived from.
 */
function staleInputReasons(deps: IntegrationDeps): string[] {
  const reasons: string[] = [];
  if (deps.payload.taskId !== deps.task.id) {
    reasons.push(`GM2DEEP-PATCH-STALE-INPUT: patch declares task ${deps.payload.taskId}, integrating ${deps.task.id}`);
  }
  if (canonicalJson(deps.payload.contractVersions) !== canonicalJson(deps.currentContractVersions)) {
    reasons.push(
      `GM2DEEP-PATCH-STALE-INPUT: contract versions drifted (patch ${canonicalJson(deps.payload.contractVersions)}, current ${canonicalJson(deps.currentContractVersions)})`,
    );
  }
  if (deps.payload.inputHash !== deps.expectedInputHash) {
    reasons.push(
      `GM2DEEP-PATCH-STALE-INPUT: unit input hash drifted (patch ${deps.payload.inputHash}, current ${deps.expectedInputHash})`,
    );
  }
  if (deps.baselineId !== deps.currentBaselineId) {
    reasons.push(
      `GM2DEEP-PATCH-STALE-INPUT: baseline drifted (patch ${deps.baselineId}, current ${deps.currentBaselineId})`,
    );
  }
  return reasons;
}

/**
 * Integrate one patch. Steps 1-8 of the plan run in order: staleness, allowlist gate, base revision,
 * candidate copy, structural and acceptance checks, review, publish inside the port mutex, accepted.
 *
 * Policy, staleness and check failures come back as `state: "rejected"` with reasons; only genuine I/O
 * faults throw. The candidate directory is always removed, so a rejected attempt cannot leave the port
 * anything other than byte-identical.
 */
export async function integrateTask(deps: IntegrationDeps): Promise<IntegrationOutcome> {
  const { task, payload } = deps;

  // (0) publication is keyed by (taskId, patchSha256, basePortRevision). A duplicate integration is a
  // no-op that returns the original row — it must not rebuild a candidate from a port that already
  // carries the change, which would fail the pre-image check below.
  const alreadyPublished = deps.repo.getIntegrationByKey(
    integrationIdempotencyKey(task.id, patchPayloadSha256(payload), payload.basePortRevision),
  );
  if (alreadyPublished !== null) {
    return {
      state: "accepted",
      reasons: [
        `GM2DEEP-PATCH-ALREADY-PUBLISHED: task ${task.id} attempt ${payload.attempt} was published as revision ${alreadyPublished.publishedRevision}`,
      ],
      revision: alreadyPublished.publishedRevision,
      integrationId: alreadyPublished.id,
      checks: [],
      review: null,
    };
  }

  // (1) the patch must still belong to the plan, unit input and baseline it was produced against.
  const stale = staleInputReasons(deps);
  if (stale.length > 0) return rejected(stale);

  // (2) the same gate the `propose_patch` tool applies: protected paths first, then the task write
  // allowlist, then duplicate paths, declared content hashes and Godot parseability.
  const submission: ImplementerSubmission = {
    schemaVersion: payload.schemaVersion,
    files: payload.files,
    summary: payload.summary,
  };
  try {
    validateProposedPatch(task, submission);
  } catch (error) {
    if (error instanceof DeepError) return rejected([`${error.code}: ${error.message}`]);
    throw error;
  }

  // (3) the port must still be at the revision the patch was based on.
  if (payload.basePortRevision !== deps.currentPortRevision) {
    return rejected([
      `GM2DEEP-PATCH-STALE-BASE: patch was based on port revision ${payload.basePortRevision}, current revision is ${deps.currentPortRevision}`,
    ]);
  }

  // (4) build the candidate from the current port and apply the recorded file bodies. The copy skips
  // the indexing exclusions (VCS, editor and JIT caches: .git, .godot, __pycache__ …), which the port
  // never legitimately carries and which the validation runner would regenerate anyway.
  const candidateDir = join(deps.workspace.paths.tasks, task.id, `attempt-${payload.attempt}`, "candidate");
  let candidateCreated = false;
  try {
    rmSync(candidateDir, { recursive: true, force: true });
    mkdirSync(dirname(candidateDir), { recursive: true });
    copyTree(deps.workspace.paths.port, candidateDir);
    candidateCreated = true;
    applyPatchToTree(candidateDir, payload);

    // (5) structural and acceptance checks decide the patch, never an agent's prose.
    let checks: readonly ValidationResult[];
    try {
      checks = await deps.runChecks(candidateDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return rejected([`GM2DEEP-CANDIDATE-CHECKS-FAILED: validation runner failed: ${message}`]);
    }
    if (checks.length === 0) {
      return rejected(["GM2DEEP-CANDIDATE-UNVERIFIED: no validation checks were run for the candidate"]);
    }
    const failed = checks.filter((check) => check.state === "failed");
    if (failed.length > 0) {
      return rejected(
        failed.map(
          (check) =>
            `GM2DEEP-CHECK-FAILED: level ${check.level} ${check.checkId} (${check.name}) failed${check.reason === undefined ? "" : `: ${check.reason}`}`,
        ),
        checks,
      );
    }

    // (6) review when the task demands it; an unavailable reviewer is never an approval.
    let review: PatchReviewVerdict | null = null;
    if (task.reviewRequired) {
      const preimages = preimagesForRoot(deps.workspace.paths.port, payload);
      review = await reviewPatch({
        runtime: deps.runtime,
        task,
        payload,
        diff: renderUnifiedDiff(payload, { preimages }),
        checks,
        workspaceRoots: deps.workspaceRoots,
        credentials: deps.credentials,
        signal: deps.signal,
        contracts: deps.contracts ?? [],
        tools: deps.tools ?? [],
        logger: deps.logger,
        recordPolicyDenial: deps.recordPolicyDenial,
      });
      if (review.verdict !== "approved") {
        return rejected([`GM2DEEP-REVIEW-${review.verdict.toUpperCase()}`, ...review.reasons], checks, review);
      }
    }

    // (7) publish under the single-writer port mutex.
    const publishDeps = {
      repo: deps.repo,
      portDir: deps.workspace.paths.port,
      task,
      payload,
      files: payload.files.map((file) => file.path),
    };
    const published =
      deps.portMutex === undefined ? publishPatch(publishDeps) : await deps.portMutex(() => publishPatch(publishDeps));

    // (8) accepted, with the revision the port now holds and the integration row that recorded it.
    return {
      state: "accepted",
      reasons: [],
      revision: published.revision,
      integrationId: published.integration.id,
      checks,
      review,
    };
  } finally {
    if (candidateCreated) removeTree(candidateDir);
  }
}
