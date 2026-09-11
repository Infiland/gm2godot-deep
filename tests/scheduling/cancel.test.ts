import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import { createMockRuntime } from "../../src/agents/mock/mockRuntime.ts";
import { outcomeFrom } from "../../src/agents/result.ts";
import { ZERO_USAGE, type AgentRunRequest, type AgentRuntime } from "../../src/agents/runtime.ts";
import { TaskMachine } from "../../src/scheduling/machine.ts";
import { silentLogger } from "../../src/util/log.ts";
import { DeepError } from "../../src/util/result.ts";
import { runRepairLoop } from "../../src/validation/repair.ts";
import { tempDir, tempRepo } from "../helpers/environment.ts";
import type { Repo } from "../../src/storage/repo.ts";
import type { TaskRecord, TaskState } from "../../src/storage/types.ts";

function insertTask(repo: Repo, id: string, state: TaskState): TaskRecord {
  repo.insertTask({
    id,
    unitIds: ["script:scr_math"],
    role: "implementer",
    state,
    strategy: "repair_generated",
    maxAttempts: 3,
    allowlist: { read: ["scripts/scr_math"], write: ["scripts/scr_math/scr_math.gd"] },
    dependsOn: [],
    contractVersions: {},
    inputHash: "input-hash",
    acceptanceCheckIds: ["D/behavioral"],
    reviewRequired: false,
    budgets: { maxAttempts: 3, maxModelTokens: null, maxCostUsd: null, timeoutSeconds: 60 },
  });
  const task = repo.getTask(id);
  assert.ok(task !== null, `task ${id} must be persisted`);
  return task;
}

function requestFor(signal: AbortSignal, taskId: string): AgentRunRequest {
  return {
    role: "implementer",
    taskId,
    systemPrompt: "test system prompt",
    userPrompt: "test user prompt",
    tools: [],
    workspaceRoots: {
      source: "/nonexistent/source",
      baseline: "/nonexistent/baseline",
      port: "/nonexistent/port",
      task: "/nonexistent/task",
      evidence: "/nonexistent/evidence",
    },
    allowlist: { read: [], write: [] },
    resultSchema: z.object({}),
    maxTurns: 3,
    timeoutSeconds: 5,
    budgets: { tokens: null, costUsd: null },
    signal,
    credentials: {},
    attempt: 1,
    logger: silentLogger,
    recordPolicyDenial: () => {},
  };
}

test("an already-aborted run yields outcome aborted, with no result and unreported zero usage", async () => {
  const temp = tempDir("gm2deep-cancel-runtime");
  try {
    let factsAssembled = 0;
    const runtime = createMockRuntime({
      transcriptsDir: join(temp.path, "transcripts"),
      factsFor: () => {
        factsAssembled += 1;
        throw new Error("an aborted run must not assemble unit facts");
      },
    });
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.run(requestFor(controller.signal, "task:aborted"));

    assert.equal(result.outcome, "aborted");
    assert.equal(result.result, undefined);
    assert.equal(result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite, 0);
    assert.equal(result.usage.costUsd, 0);
    assert.equal(result.usage.reported, false);
    assert.ok(result.reason?.includes("aborted"), result.reason ?? "");
    assert.equal(factsAssembled, 0);

    assert.ok(existsSync(result.transcriptPath), "the transcript must still be written");
    const transcript = readFileSync(result.transcriptPath, "utf8");
    assert.ok(transcript.includes('"aborted":true'), transcript);
    assert.ok(transcript.includes('"simulated":true'));
  } finally {
    temp.cleanup();
  }
});

test("abort and timeout outcomes are derived after the budget check", () => {
  const limits = { aborted: true, timedOut: false, tokens: null, costUsd: null };
  assert.equal(outcomeFrom(undefined, { ...ZERO_USAGE }, limits), "aborted");
  // A crossed ceiling is the reason the run ended, even when the abort also fired.
  assert.equal(outcomeFrom(undefined, { ...ZERO_USAGE, input: 11, reported: true }, { ...limits, tokens: 10 }), "budget_exceeded");
  assert.equal(outcomeFrom(undefined, { ...ZERO_USAGE }, { aborted: false, timedOut: true, tokens: null, costUsd: null }), "timeout");
  assert.equal(outcomeFrom(undefined, { ...ZERO_USAGE }, { aborted: false, timedOut: false, tokens: null, costUsd: null }), "no_result");
});

test("a cancelled run leaves its task CANCELLED and publishes nothing", () => {
  const { repo, cleanup } = tempRepo("gm2deep-cancel-task");
  try {
    const machine = new TaskMachine(repo);
    insertTask(repo, "task:cancel", "RUNNING");
    machine.transition("task:cancel", "CANCELLED", { detail: { by: "test" } });

    const task = repo.getTask("task:cancel");
    assert.ok(task !== null);
    assert.equal(task.state, "CANCELLED");
    assert.equal(task.attempt, 0, "a cancelled run does not count as an attempt");
    const events = repo.listEvents("task:cancel");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.fromState, "RUNNING");
    assert.equal(events[0]?.toState, "CANCELLED");

    assert.deepEqual(repo.listPatches("task:cancel"), []);
    assert.deepEqual(repo.listIntegrations(), []);
    assert.deepEqual(
      repo.listPortRevisions().map((revision) => revision.revision),
      [0],
      "a cancelled task must not publish a port revision",
    );
  } finally {
    cleanup();
  }
});

test("an aborted attempt returns its task to READY only through a recorded reason", () => {
  const { repo, cleanup } = tempRepo("gm2deep-cancel-ready");
  try {
    const machine = new TaskMachine(repo);
    insertTask(repo, "task:abort", "RUNNING");
    machine.transition("task:abort", "BLOCKED", { detail: { reason: "the run was aborted before the implementer ran" } });
    assert.equal(repo.getTask("task:abort")?.state, "BLOCKED");

    // A silent walk back to READY is refused; the resume path must record why.
    assert.throws(
      () => machine.transition("task:abort", "READY"),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, "GM2DEEP-TRANSITION-REASON-REQUIRED");
        return true;
      },
    );
    assert.equal(repo.getTask("task:abort")?.state, "BLOCKED");

    machine.transition("task:abort", "READY", { reason: "resume", detail: { previousOwner: "worker-1" } });
    const requeued = repo.getTask("task:abort");
    assert.ok(requeued !== null);
    assert.equal(requeued.state, "READY");
    const last = repo.listEvents("task:abort").at(-1);
    assert.equal(last?.fromState, "BLOCKED");
    assert.equal(last?.toState, "READY");
    assert.equal(JSON.stringify(last?.detail).includes("resume"), true);
  } finally {
    cleanup();
  }
});

test("the repair loop never runs the implementer for an aborted run, so no patch is applied", async () => {
  const temp = tempDir("gm2deep-cancel-repair");
  const { repo, cleanup } = tempRepo("gm2deep-cancel-repair-repo");
  try {
    insertTask(repo, "task:abort", "RUNNING");
    const controller = new AbortController();
    controller.abort();
    let requestsBuilt = 0;
    let implementerRuns = 0;
    let applied = 0;

    const runtime: AgentRuntime = {
      id: "mock",
      simulated: true,
      run: async () => {
        implementerRuns += 1;
        throw new Error("the implementer must not run after an abort");
      },
    };

    const outcome = await runRepairLoop({
      maxRepairAttempts: 2,
      candidateWorkspace: join(temp.path, "candidate"),
      runtime,
      implementerRequest: () => {
        requestsBuilt += 1;
        return requestFor(controller.signal, "task:abort");
      },
      applyResult: async () => {
        applied += 1;
      },
      validate: async () => [],
      signal: controller.signal,
    });

    assert.equal(outcome.state, "blocked");
    assert.ok(outcome.blockReason?.includes("aborted"), outcome.blockReason ?? "");
    assert.equal(outcome.repairAttempts, 0);
    assert.equal(requestsBuilt, 0);
    assert.equal(implementerRuns, 0);
    assert.equal(applied, 0);
    assert.deepEqual(repo.listPatches("task:abort"), []);
    assert.deepEqual(repo.listIntegrations(), []);
  } finally {
    cleanup();
    temp.cleanup();
  }
});
