import type { PatchRecordPayload } from "../evidence/schemas.ts";
import type { Repo } from "../storage/repo.ts";
import type { IntegrationRecord, TaskRecord } from "../storage/types.ts";
import { canonicalJson } from "../util/json.ts";
import { newId } from "../util/ids.ts";
import { DeepError } from "../util/result.ts";
import { sha256Text } from "../util/sha256.ts";
import { assertAllowed, normalizeRepoPath } from "./allowlist.ts";
import { applyFileEntry } from "./diff.ts";

/** Identity of a patch payload, independent of when it was written or by which attempt. */
export function patchPayloadSha256(payload: PatchRecordPayload): string {
  return sha256Text(canonicalJson(payload));
}

/** The publication identity: a published patch is never applied twice for the same base revision. */
export function integrationIdempotencyKey(taskId: string, patchSha256: string, basePortRevision: number): string {
  return sha256Text(`${taskId}|${patchSha256}|${basePortRevision}`);
}

export interface PublishDeps {
  readonly repo: Repo;
  readonly portDir: string;
  readonly task: TaskRecord;
  readonly payload: PatchRecordPayload;
  /** The changed paths this publication covers; must equal the payload's file list. */
  readonly files: readonly string[];
}

export interface PublishResult {
  readonly integration: IntegrationRecord;
  readonly revision: number;
  /** False when an identical publication already existed and nothing was written. */
  readonly created: boolean;
}

/**
 * Publish a patch into `port/` exactly once per `(taskId, patchSha256, basePortRevision)`.
 *
 * The integration row is inserted **before** the files are written and its `published_revision` is the
 * predicted next revision; the real revision is bumped only after the copy. A crash in between is
 * therefore visible as an integration row whose revision does not exist in `port_revisions`, rather
 * than as a silent half-published port. A duplicate call returns the original row untouched.
 */
export function publishPatch(deps: PublishDeps): PublishResult {
  const { repo, portDir, task, payload } = deps;
  const patchSha256 = patchPayloadSha256(payload);
  const idempotencyKey = integrationIdempotencyKey(task.id, patchSha256, payload.basePortRevision);

  const existing = repo.getIntegrationByKey(idempotencyKey);
  if (existing !== null) return { integration: existing, revision: existing.publishedRevision, created: false };

  const changed = deps.files.map((path) => normalizeRepoPath(path));
  const declared = payload.files.map((file) => normalizeRepoPath(file.path));
  const missing = declared.filter((path) => !changed.includes(path));
  const unknown = changed.filter((path) => !declared.includes(path));
  if (missing.length > 0 || unknown.length > 0) {
    throw new DeepError("GM2DEEP-PUBLISH-FILE-SET-MISMATCH", "publish file list does not match the patch payload", {
      taskId: task.id,
      missingFromPublish: missing,
      notInPatch: unknown,
    });
  }
  for (const file of payload.files) assertAllowed(task, file.path, file.action);

  const integrationId = newId("int");
  const predictedRevision = repo.currentPortRevision() + 1;
  const inserted = repo.insertIntegration({
    id: integrationId,
    taskId: task.id,
    patchSha256,
    basePortRevision: payload.basePortRevision,
    publishedRevision: predictedRevision,
    idempotencyKey,
    files: changed,
  });
  if (inserted.id !== integrationId) {
    // A concurrent publication of the same patch won the insert and owns the write.
    return { integration: inserted, revision: inserted.publishedRevision, created: false };
  }

  for (const file of payload.files) applyFileEntry(portDir, file, { tolerateIdentical: true });

  const revision = repo.bumpPortRevision({ taskId: task.id, integrationId: inserted.id, files: changed });
  if (revision !== predictedRevision) {
    throw new DeepError("GM2DEEP-PUBLISH-REVISION-RACE", "the port revision changed while a patch was being published", {
      taskId: task.id,
      predictedRevision,
      actualRevision: revision,
      integrationId: inserted.id,
    });
  }
  return { integration: inserted, revision, created: true };
}
