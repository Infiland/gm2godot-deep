import assert from "node:assert/strict";
import test from "node:test";
import { ModelBudgetGate } from "../../src/scheduling/modelBudgetGate.ts";
import { BudgetLedger } from "../../src/scheduling/budgets.ts";
import type {
  AgentRunRequest,
  AgentRunResult,
} from "../../src/agents/runtime.ts";
import { tempRepo } from "../helpers/environment.ts";

const request = (taskId: string): AgentRunRequest =>
  ({
    taskId,
    signal: new AbortController().signal,
    budgets: { tokens: 100, costUsd: 2 },
  }) as AgentRunRequest;
const result = (tokens: number, costUsd: number): AgentRunResult => ({
  outcome: "completed",
  transcriptPath: "fixture",
  events: [],
  usage: {
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd,
    reported: true,
  },
});

test("concurrent tasks reserve and clamp global allowance, releasing unspent budget", async () => {
  const env = tempRepo("budget-gate");
  try {
    env.repo.createRun("run", "analyze", false, {});
    const ledger = new BudgetLedger(
      env.repo,
      "run",
      {
        perTaskTokens: 100,
        perTaskCostUsd: 2,
        perRunTokens: 10,
        perRunCostUsd: 1,
      },
      true,
    );
    const gate = new ModelBudgetGate(ledger);
    const release = Promise.withResolvers<void>();
    const allocations: { tokens: number | null; costUsd: number | null }[] = [];
    const first = gate.run(request("A"), async (req) => {
      allocations.push(req.budgets);
      await release.promise;
      return result(4, 0.4);
    });
    const second = gate.run(request("B"), async (req) => {
      allocations.push(req.budgets);
      return result(6, 0.6);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      allocations,
      [{ tokens: 10, costUsd: 1 }],
      "second worker waits while the first reserves all available tokens",
    );
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(allocations[1], { tokens: 6, costUsd: 0.6 });
    assert.equal(env.repo.totalsForWorkspace().input, 10);
    await assert.rejects(
      () =>
        gate.run(request("C"), async () => {
          throw new Error("must not dispatch");
        }),
      /budget exhausted/,
    );
  } finally {
    env.cleanup();
  }
});

test("a thrown provider invocation cannot silently release possibly consumed allowance", async () => {
  const env = tempRepo("budget-uncertain");
  try {
    env.repo.createRun("run", "analyze", false, {});
    const ledger = new BudgetLedger(
      env.repo,
      "run",
      {
        perTaskTokens: 100,
        perTaskCostUsd: 2,
        perRunTokens: 10,
        perRunCostUsd: 1,
      },
      true,
    );
    const gate = new ModelBudgetGate(ledger);
    await assert.rejects(
      () =>
        gate.run(request("A"), async () => {
          throw new Error("transport lost after request");
        }),
      /transport lost/,
    );
    assert.deepEqual(env.repo.totalsForWorkspace(), {
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 1,
      reported: false,
    });
    await assert.rejects(
      () =>
        gate.run(request("B"), async () => {
          throw new Error("must not dispatch");
        }),
      /budget exhausted/,
    );
  } finally {
    env.cleanup();
  }
});
