import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../../src/cli/main.ts";
import { reclaimExpired, retryStuckTasks } from "../../src/scheduling/leases.ts";
import { SNAPSHOT_FILENAME } from "../../src/indexing/inventory.ts";
import { snapshotSource, verifySnapshot, writeSnapshotRecord } from "../../src/workspaces/snapshot.ts";
import {
  BASELINE_EVIDENCE_FILENAME,
  readBaselineEvidence,
  type BaselineEvidence,
} from "../../src/adapters/gm2godot/adapter.ts";
import {
  ATTEMPT_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
  readBaselineProvenance,
} from "../../src/adapters/gm2godot/manifest.ts";
import { writeJsonAtomic } from "../../src/util/json.ts";
import { createTestWorkspace, hashBytes, insertTask, writeFileEnsured, writeTinyGmProject } from "../helpers/harness.ts";

function freshManifest(targetPlatform: string) {
  return {
    format_version: 2,
    conversion: {
      state: "success",
      converters: { requested: 1, executed: 1, completed: 1, skipped: 0, failed: 0 },
      resources: { requested: 0, executed: 0, completed: 0, skipped: 0, failed: 0 },
      failed_step: null,
      failure_phase: null,
    },
    target_platform: targetPlatform,
    enabled_converters: ["objects"],
    source_project: {
      name: "Counter",
      yyp_path: "Counter.yyp",
      resource_type: "GMProject",
      resource_version: "2.0",
      ide_version: "2026.0.0.16",
    },
    resources: [],
    generation_inventory: {
      format_version: 1,
      entries: [
        {
          path: "scripts/scr_math.gd",
          kind: "script",
          owner: { class: "Script", name: "scr_math" },
          byte_count: 12,
          sha256: hashBytes("extends Node\n"),
          mode: 0o644,
        },
      ],
    },
    generated_files: [{ path: "scripts/scr_math.gd", kind: "script", sha256: hashBytes("extends Node\n") }],
    source_maps: [],
    architecture_policies: {},
    path_diagnostics: {},
  };
}

function manifestText(targetPlatform: string): string {
  return `${JSON.stringify(freshManifest(targetPlatform), null, 2)}\n`;
}

/** Write a provenance record the freshness rule calls fresh, and return the manifest bytes' digest. */
function writeFreshBaseline(baselineDir: string, targetPlatform = "macos"): string {
  const text = manifestText(targetPlatform);
  const manifestSha = hashBytes(text);
  writeFileEnsured(join(baselineDir, MANIFEST_RELATIVE_PATH), text);
  writeJsonAtomic(join(baselineDir, ATTEMPT_RELATIVE_PATH), {
    format_version: 1,
    attempt: {
      state: "success",
      converters: {},
      steps: {},
      resources: {},
      failed_step: null,
      failure_phase: null,
      cancelled: false,
    },
    canonical_manifest: {
      path: MANIFEST_RELATIVE_PATH,
      status: "updated",
      updated: true,
      current_output: "verified",
      sha256: manifestSha,
    },
  });
  return manifestSha;
}

function baselineEvidenceFor(baselineId: string): BaselineEvidence {
  return {
    schemaVersion: 1,
    baselineId,
    generatedAt: "2026-01-01T00:00:00Z",
    gm2godot: {
      version: "0.7.74",
      commit: "38b364855f06e971d2676b921fd300e1f40f076a",
      checkout: "/checkout",
      python: "/python",
      pythonVersion: "3.12.10",
      platform: "macos",
      groups: ["assets", "project", "wip"],
      only: [],
    },
    exitCode: 0,
    state: "success",
    outcome: "success",
    summaryLine: "GM2Godot conversion outcome: success",
    manifestSha256: baselineId,
    attemptSha256: hashBytes("attempt"),
    generationInventoryFormatVersion: 1,
    entryCount: 1,
    preservedGeneration: null,
    reasons: [],
    godotProjectDir: "baseline",
    reportsDir: "reports",
  };
}

test("resume reclaims an expired RUNNING lease with attempt+1 and leaves ACCEPTED tasks accepted", () => {
  const ws = createTestWorkspace("resume-reclaim");
  try {
    const crashed = insertTask(ws.repo, { id: "crashed", state: "RUNNING", write: ["gm2godot/**"] });
    const accepted = insertTask(ws.repo, { id: "accepted", state: "ACCEPTED", write: ["gm2godot/**"] });
    const live = insertTask(ws.repo, { id: "live", state: "RUNNING", write: ["gm2godot/**"] });
    // A negative TTL puts the lease in the past: the owner died without releasing it.
    ws.repo.ensureLeaseRow(crashed.id);
    ws.repo.ensureLeaseRow(accepted.id);
    ws.repo.ensureLeaseRow(live.id);
    assert.equal(ws.repo.acquireLease(crashed.id, "dead-worker", -30), true);
    assert.equal(ws.repo.acquireLease(accepted.id, "dead-worker", -30), true);
    assert.equal(ws.repo.acquireLease(live.id, "other-worker", 600), true);
    const acceptedEventsBefore = ws.repo.listEvents(accepted.id).length;

    const outcome = reclaimExpired(ws.repo);
    assert.deepEqual(
      outcome.reclaimed.map((entry) => entry.taskId),
      ["crashed"],
    );
    assert.equal(outcome.reclaimed[0]?.previousOwner, "dead-worker");

    const requeued = ws.repo.getTask("crashed");
    assert.equal(requeued?.state, "READY");
    assert.equal(requeued?.attempt, 1, "a reclaimed task is re-queued with attempt+1");
    const events = ws.repo.listEvents("crashed");
    const expired = events.filter((event) => event.kind === "lease_expired");
    assert.equal(expired.length, 1, `expected one lease_expired event, got ${JSON.stringify(events)}`);
    assert.equal(expired[0]?.fromState, "RUNNING");
    assert.equal((expired[0]?.detail as { previousOwner?: string }).previousOwner, "dead-worker");
    // Whichever route the state machine takes (RUNNING→READY directly, or RUNNING→FAILED then
    // FAILED→READY with a recorded reason), the task must end in READY via a recorded transition.
    assert.equal(
      events.some((event) => event.toState === "READY"),
      true,
      "the re-queue to READY must be recorded",
    );
    assert.equal(ws.repo.listLeases().find((lease) => lease.taskId === "crashed")?.owner, null);

    // An ACCEPTED task keeps its verdict: the lease is released, the state is not touched, no event is added.
    assert.equal(ws.repo.getTask("accepted")?.state, "ACCEPTED");
    assert.equal(ws.repo.listEvents(accepted.id).length, acceptedEventsBefore);
    assert.equal(ws.repo.listLeases().find((lease) => lease.taskId === "accepted")?.owner, null);

    // A lease that has not expired belongs to a live worker and must be left alone.
    assert.equal(ws.repo.getTask("live")?.state, "RUNNING");
    assert.equal(ws.repo.listLeases().find((lease) => lease.taskId === "live")?.owner, "other-worker");
  } finally {
    ws.cleanup();
  }
});

test("resume's explicit retries return BLOCKED and FAILED tasks to READY", () => {
  const ws = createTestWorkspace("resume-retry");
  try {
    insertTask(ws.repo, { id: "blocked", state: "BLOCKED", blockReason: "needs approval" });
    insertTask(ws.repo, { id: "failed", state: "FAILED" });
    const moved = retryStuckTasks(ws.repo, ["BLOCKED", "FAILED"], "retry");
    assert.deepEqual([...moved].sort(), ["blocked", "failed"]);
    assert.equal(ws.repo.getTask("blocked")?.state, "READY");
    assert.equal(ws.repo.getTask("failed")?.state, "READY");
    assert.equal(
      ws.repo.listEvents("failed").some((event) => event.toState === "READY" && event.kind === "state"),
      true,
    );
  } finally {
    ws.cleanup();
  }
});

test("resume re-verifies the source snapshot: a drift fails with GM2DEEP-SOURCE-SNAPSHOT-CHANGED", async () => {
  const ws = createTestWorkspace("resume-snapshot");
  try {
    const record = await snapshotSource(ws.workspace.config.source.path, ws.workspace.paths.source, {
      freeze: false,
    });
    writeSnapshotRecord(join(ws.workspace.paths.evidenceInventory, SNAPSHOT_FILENAME), record);
    await verifySnapshot(ws.workspace.paths.source, record);

    const snapshotFile = join(ws.workspace.paths.source, "scripts", "scr_tiny", "scr_tiny.gml");
    const original = readFileSync(snapshotFile, "utf8");
    appendFileSync(snapshotFile, "// drift\n", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(["resume", "--workspace", ws.workspace.root], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    assert.equal(code, 1, `resume must fail on a drifted snapshot; stdout=${stdout.join(" | ")}`);
    assert.match(stderr.join("\n"), /GM2DEEP-SOURCE-SNAPSHOT-CHANGED/);

    // Restoring the bytes makes the recorded id valid again: the drift, not the check, was the cause.
    writeFileSync(snapshotFile, original, "utf8");
    await verifySnapshot(ws.workspace.paths.source, record);
  } finally {
    ws.cleanup();
  }
});

test("resume's baseline check is byte-derived: a changed manifest changes the baseline id resume compares", () => {
  const ws = createTestWorkspace("resume-baseline");
  try {
    const baselineId = writeFreshBaseline(ws.workspace.paths.baseline);
    writeJsonAtomic(join(ws.workspace.paths.evidenceInventory, BASELINE_EVIDENCE_FILENAME), baselineEvidenceFor(baselineId));

    const provenance = readBaselineProvenance(ws.workspace.paths.baseline);
    assert.equal(provenance.fresh, true, provenance.reasons.join("; "));
    assert.equal(provenance.baselineId, baselineId);
    assert.equal(readBaselineEvidence(ws.workspace.paths.evidenceInventory).baselineId, baselineId);

    // The manifest bytes changed without the run recording a new attempt: the derived id no longer
    // matches the recorded evidence, so resume must not treat the destination as the generation it recorded.
    writeFileEnsured(join(ws.workspace.paths.baseline, MANIFEST_RELATIVE_PATH), manifestText("linux"));
    const drifted = readBaselineProvenance(ws.workspace.paths.baseline);
    assert.notEqual(drifted.baselineId, readBaselineEvidence(ws.workspace.paths.evidenceInventory).baselineId);
    assert.equal(drifted.fresh, false);
    assert.match(drifted.reasons.join("; "), /digest .* does not match the manifest bytes/);
  } finally {
    ws.cleanup();
  }
});
