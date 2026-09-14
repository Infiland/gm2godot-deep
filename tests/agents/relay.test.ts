import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createRelayRuntime } from "../../src/agents/external/relay.ts";
import { ZERO_USAGE, type AgentRunRequest } from "../../src/agents/runtime.ts";
import { createLogger } from "../../src/util/log.ts";
function request(
  dir: string,
  denied: (detail: unknown) => void,
): AgentRunRequest {
  return {
    role: "analyst",
    taskId: "test",
    attempt: 1,
    systemPrompt: "Synthetic tool test",
    userPrompt: "Read then submit",
    tools: [
      {
        name: "read_source",
        description: "Read synthetic source",
        schema: z.strictObject({}),
        execute: async () => ({ text: "hp=3;" }),
      },
      {
        name: "submit_analysis",
        description: "Submit answer",
        schema: z.strictObject({ hp: z.number() }),
        execute: async (args) => ({
          text: "accepted",
          details: args,
          terminate: true,
        }),
      },
    ],
    workspaceRoots: {
      source: dir,
      baseline: dir,
      port: dir,
      task: dir,
      evidence: dir,
    },
    allowlist: { read: [], write: [] },
    resultSchema: z.strictObject({ hp: z.number() }),
    maxTurns: 3,
    timeoutSeconds: 10,
    budgets: { tokens: 10000, costUsd: 1 },
    signal: new AbortController().signal,
    credentials: {},
    logger: createLogger({ stderr: () => {} }),
    recordPolicyDenial: denied,
  };
}
test("external relay executes only host tools and validates terminating results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-relay-test-"));
  let calls = 0,
    closed = false;
  try {
    const runtime = createRelayRuntime({
      id: "claude",
      provider: null,
      model: "test-model",
      freeOnly: false,
      transcriptsDir: dir,
      create: () => ({
        close: async () => {
          closed = true;
        },
        complete: async () => ({
          value:
            calls++ === 0
              ? { tool: "read_source", argsJson: "{}" }
              : { tool: "submit_analysis", argsJson: '{"hp":3}' },
          usage: ZERO_USAGE,
        }),
      }),
    });
    const result = await runtime.run(
      request(dir, () => assert.fail("Unexpected denial")),
    );
    assert.equal(result.outcome, "completed");
    assert.deepEqual(result.result, { hp: 3 });
    assert.equal(calls, 2);
    assert.equal(closed, true);
    assert.equal(result.provenance?.model, "test-model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("external relay denies unavailable tools and stops on estimated input budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-relay-denial-"));
  let calls = 0,
    denials = 0;
  try {
    const runtime = createRelayRuntime({
      id: "codex",
      provider: null,
      model: "test-model",
      freeOnly: false,
      transcriptsDir: dir,
      create: () => ({
        close: async () => {},
        complete: async () => {
          calls++;
          return {
            value: { tool: "exec", argsJson: '{"command":"unsafe"}' },
            usage: ZERO_USAGE,
          };
        },
      }),
    });
    const r = request(dir, () => {
      denials++;
    });
    assert.equal((await runtime.run(r)).outcome, "failed");
    assert.equal(denials, 1);
    assert.equal(
      (
        await runtime.run({
          ...r,
          taskId: "budget",
          budgets: { tokens: 1, costUsd: 0 },
        })
      ).outcome,
      "budget_exceeded",
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed model responses retain reported usage rather than releasing it as zero", async () => {
  const { TransportFailure } = await import(
    "../../src/agents/external/transport.ts"
  );
  const dir = mkdtempSync(join(tmpdir(), "deep-relay-spend-"));
  try {
    const usage = {
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 0,
      costUsd: 0.01,
      reported: true,
    };
    const runtime = createRelayRuntime({
      id: "claude",
      provider: null,
      model: "test",
      freeOnly: false,
      transcriptsDir: dir,
      create: () => ({
        close: async () => {},
        complete: async () => {
          throw new TransportFailure("Malformed answer", usage);
        },
      }),
    });
    const result = await runtime.run(request(dir, () => {}));
    assert.equal(result.outcome, "failed");
    assert.deepEqual(result.usage, usage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
