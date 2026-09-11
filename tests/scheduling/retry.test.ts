import assert from "node:assert/strict";
import test from "node:test";

import { decideModelRetry, decideRepair, failureEvidenceFrom } from "../../src/scheduling/retry.ts";
import { TaskMachine } from "../../src/scheduling/machine.ts";
import { tempRepo } from "../helpers/environment.ts";
import type { Repo } from "../../src/storage/repo.ts";
import type { TaskRecord, TaskState } from "../../src/storage/types.ts";

function insertImplementTask(repo: Repo, id: string, state: TaskState, maxAttempts: number): TaskRecord {
  repo.insertTask({
    id,
    unitIds: ["script:scr_math"],
    role: "implementer",
    state,
    strategy: "repair_generated",
    maxAttempts,
    allowlist: { read: ["scripts/scr_math"], write: ["scripts/scr_math/scr_math.gd"] },
    dependsOn: [],
    contractVersions: {},
    inputHash: "input-hash",
    acceptanceCheckIds: ["D/behavioral"],
    reviewRequired: false,
    budgets: { maxAttempts, maxModelTokens: null, maxCostUsd: null, timeoutSeconds: 60 },
  });
  const task = repo.getTask(id);
  assert.ok(task !== null, `task ${id} must be persisted`);
  return task;
}

test("model retries increment to maxAttempts, then give up with the accumulated evidence", () => {
  const { repo, cleanup } = tempRepo("gm2deep-retry");
  try {
    const machine = new TaskMachine(repo);
    insertImplementTask(repo, "task:a", "RUNNING", 2);

    const evidenceAfterFirstFailure = ["2026-01-01T00:00:00Z failure: level D mismatch"];
    machine.record("task:a", "failure", { check: "D/behavioral", reason: "level D mismatch" });
    let task = repo.getTask("task:a");
    assert.ok(task !== null);
    assert.equal(decideModelRetry(task, evidenceAfterFirstFailure).action, "retry");

    // RUNNING -> FAILED -> READY -> RUNNING is the only retry path, and the attempt counter advances.
    machine.transition("task:a", "FAILED", { detail: { reason: "level D mismatch" } });
    machine.transition("task:a", "READY", { reason: "retry" });
    machine.transition("task:a", "RUNNING", { incrementAttempt: true });
    task = repo.getTask("task:a");
    assert.ok(task !== null);
    assert.equal(task.attempt, 1);

    const afterFirst = failureEvidenceFrom(repo.listEvents("task:a"));
    assert.equal(afterFirst.length, 1);
    assert.ok(afterFirst[0]?.includes("level D mismatch"));

    const firstDecision = decideModelRetry(task, afterFirst);
    assert.equal(firstDecision.action, "retry");
    assert.equal(firstDecision.attempt, 2);
    assert.deepEqual(firstDecision.context, afterFirst);
    assert.ok(firstDecision.reason.includes("attempt 1 of 2"));

    machine.record("task:a", "check_failed", { check: "B/structural", reason: "missing preload" });
    const accumulated = failureEvidenceFrom(repo.listEvents("task:a"));
    assert.equal(accumulated.length, 2, "each failure must be kept as evidence for the next attempt");
    assert.ok(accumulated.some((line) => line.includes("missing preload")));

    machine.transition("task:a", "FAILED", { detail: { reason: "missing preload" } });
    machine.transition("task:a", "READY", { reason: "retry" });
    machine.transition("task:a", "RUNNING", { incrementAttempt: true });
    task = repo.getTask("task:a");
    assert.ok(task !== null);
    assert.equal(task.attempt, task.maxAttempts);

    const exhausted = decideModelRetry(task, accumulated);
    assert.equal(exhausted.action, "give_up");
    assert.equal(exhausted.attempt, task.maxAttempts);
    assert.ok(exhausted.reason.includes("exhausted"), exhausted.reason);
    assert.deepEqual(exhausted.context, accumulated);

    machine.transition("task:a", "FAILED", { detail: { reason: "attempts exhausted" } });
    const final = repo.getTask("task:a");
    assert.ok(final !== null);
    assert.equal(final.state, "FAILED");
    assert.equal(final.attempt, 2);
    // The evidence chain survives the terminal transition.
    assert.equal(failureEvidenceFrom(repo.listEvents("task:a")).length, 2);
  } finally {
    cleanup();
  }
});

test("repair attempts are bounded by maxRepairAttempts and then block with the failing checks", () => {
  const { repo, cleanup } = tempRepo("gm2deep-repair");
  try {
    const policy = { maxTaskAttempts: 3, maxRepairAttempts: 2 };
    const failingChecks = ["D/behavioral", "B/structural"];

    const first = decideRepair(0, policy, failingChecks);
    assert.equal(first.action, "repair");
    assert.equal(first.repairAttempt, 1);
    assert.ok(first.reason.includes("D/behavioral"));

    const second = decideRepair(1, policy, failingChecks);
    assert.equal(second.action, "repair");
    assert.equal(second.repairAttempt, 2);

    const exhausted = decideRepair(2, policy, failingChecks);
    assert.equal(exhausted.action, "blocked");
    assert.equal(exhausted.repairAttempt, 2);
    assert.ok(exhausted.reason.includes("exhausted"), exhausted.reason);
    assert.ok(exhausted.reason.includes("B/structural"));

    const none = decideRepair(0, { maxTaskAttempts: 3, maxRepairAttempts: 0 }, failingChecks);
    assert.equal(none.action, "blocked");
    assert.equal(none.repairAttempt, 0);

    // The repair loop never rewrites past the budget: REPAIR_REQUIRED -> BLOCKED carries the reason.
    const machine = new TaskMachine(repo);
    insertImplementTask(repo, "task:b", "VALIDATING", 3);
    machine.transition("task:b", "REPAIR_REQUIRED", { detail: { checks: failingChecks } });
    machine.transition("task:b", "RUNNING", { incrementAttempt: true });
    assert.equal(TaskMachine.canTransition("RUNNING", "REPAIR_REQUIRED"), false);
    machine.transition("task:b", "BLOCKED", { detail: { checks: failingChecks, reason: exhausted.reason } });
    repo.setTaskBlockReason("task:b", exhausted.reason);

    const blocked = repo.getTask("task:b");
    assert.ok(blocked !== null);
    assert.equal(blocked.state, "BLOCKED");
    assert.ok(blocked.blockReason?.includes("exhausted"), blocked.blockReason ?? "");
    assert.ok(blocked.blockReason?.includes("D/behavioral"));
  } finally {
    cleanup();
  }
});
