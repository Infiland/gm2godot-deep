import assert from "node:assert/strict";
import test from "node:test";

import { BudgetLedger } from "../../src/scheduling/budgets.ts";
import { LeaseManager } from "../../src/scheduling/leases.ts";
import { dispatchAll } from "../../src/scheduling/scheduler.ts";
import { silentLogger } from "../../src/util/log.ts";
import { DeepError } from "../../src/util/result.ts";
import { tempRepo } from "../helpers/environment.ts";

const ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  reported: true,
} as const;

test("a per-task token ceiling is crossed by the charge that exceeds it", () => {
  const { repo, cleanup } = tempRepo("gm2deep-budget-task");
  try {
    const run = repo.createRun("run_task", "implement", true);
    const ledger = new BudgetLedger(repo, run.id, {
      perTaskTokens: 10,
      perTaskCostUsd: null,
      perRunTokens: null,
      perRunCostUsd: null,
    });

    const first = ledger.charge("task:a", { ...ZERO, input: 6, output: 4 });
    assert.equal(first.exceeded, false);
    assert.equal(first.scope, null);
    assert.equal(first.task.input + first.task.output, 10);

    const second = ledger.charge("task:a", { ...ZERO, input: 1 });
    assert.equal(second.exceeded, true);
    assert.equal(second.scope, "task");
    assert.ok(second.reason?.includes("11 tokens"), second.reason ?? "");
    assert.ok(second.reason?.includes("10 token ceiling"), second.reason ?? "");

    // The ceiling applies per task: another task is unaffected.
    const other = ledger.decide("task:b");
    assert.equal(other.exceeded, false);
    assert.equal(other.task.input, 0);
  } finally {
    cleanup();
  }
});

test("a per-task cost ceiling is crossed by the recorded cost", () => {
  const { repo, cleanup } = tempRepo("gm2deep-budget-cost");
  try {
    const run = repo.createRun("run_cost", "implement", true);
    const ledger = new BudgetLedger(repo, run.id, {
      perTaskTokens: null,
      perTaskCostUsd: 1,
      perRunTokens: null,
      perRunCostUsd: null,
    });
    assert.equal(
      ledger.charge("task:a", { ...ZERO, costUsd: 0.5 }).exceeded,
      false,
    );
    const decision = ledger.charge("task:a", { ...ZERO, costUsd: 0.6 });
    assert.equal(decision.exceeded, true);
    assert.equal(decision.scope, "task");
    assert.equal(decision.task.costUsd, 1.1);
    assert.ok(decision.reason?.includes("$1.1000"), decision.reason ?? "");
    assert.ok(decision.reason?.includes("$1 ceiling"), decision.reason ?? "");
  } finally {
    cleanup();
  }
});

test("a run ceiling stops further dispatches for the run", () => {
  const { repo, cleanup } = tempRepo("gm2deep-budget-run");
  try {
    const run = repo.createRun("run_ceiling", "implement", true);
    const ledger = new BudgetLedger(repo, run.id, {
      perTaskTokens: null,
      perTaskCostUsd: null,
      perRunTokens: 5,
      perRunCostUsd: null,
    });
    assert.equal(
      ledger.charge("task:a", { ...ZERO, input: 4 }).exceeded,
      false,
    );
    const decision = ledger.charge("task:b", { ...ZERO, input: 2 });
    assert.equal(decision.exceeded, true);
    assert.equal(decision.scope, "run");
    assert.equal(decision.run.input, 6);
    assert.ok(
      decision.reason?.includes("run used 6 tokens"),
      decision.reason ?? "",
    );
    assert.throws(
      () => ledger.assertNotExceeded("task:c"),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, "GM2DEEP-BUDGET-EXCEEDED");
        assert.equal(error.detail["scope"], "run");
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("usage the provider never reported counts as zero cost and says so", () => {
  const { repo, cleanup } = tempRepo("gm2deep-budget-unreported");
  try {
    const run = repo.createRun("run_unreported", "implement", true);
    const ledger = new BudgetLedger(repo, run.id, {
      perTaskTokens: 5,
      perTaskCostUsd: 1,
      perRunTokens: null,
      perRunCostUsd: null,
    });
    const decision = ledger.charge("task:a", {
      input: 4,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      reported: false,
    });
    assert.equal(decision.task.costUsd, 0);
    assert.equal(decision.task.reported, false);
    assert.equal(decision.run.costUsd, 0);
    assert.equal(decision.run.reported, false);
    assert.equal(decision.exceeded, true);
    assert.equal(decision.scope, "task");
    assert.ok(
      decision.reason?.includes("provider did not report usage"),
      decision.reason ?? "",
    );

    // A later known charge contributes cost, but cannot make earlier unknown usage fully reported.
    const reported = ledger.charge("task:a", {
      ...ZERO,
      costUsd: 0.25,
      reported: true,
    });
    assert.equal(reported.task.costUsd, 0.25);
    assert.equal(reported.task.reported, false);
  } finally {
    cleanup();
  }
});

test("a run already over its ceiling dispatches nothing; an unexceeded run dispatches everything", async () => {
  const { repo, cleanup } = tempRepo("gm2deep-budget-dispatch");
  try {
    const signal = new AbortController().signal;
    const leases = new LeaseManager(repo, "worker-test", 30);
    try {
      const overRun = new BudgetLedger(repo, "run_over", {
        perTaskTokens: null,
        perTaskCostUsd: null,
        perRunTokens: 5,
        perRunCostUsd: null,
      });
      overRun.charge(null, { ...ZERO, input: 6 });
      let executed = 0;
      const stopped = await dispatchAll(
        [
          {
            id: "item-a",
            run: async (): Promise<string> => {
              executed += 1;
              return "a";
            },
          },
          {
            id: "item-b",
            run: async (): Promise<string> => {
              executed += 1;
              return "b";
            },
          },
        ],
        {
          maxWorkers: 2,
          leases,
          budget: overRun,
          logger: silentLogger,
          signal,
        },
      );
      assert.equal(
        executed,
        0,
        "no item may run once the run ceiling is crossed",
      );
      assert.deepEqual(stopped.map((outcome) => outcome.id).sort(), [
        "item-a",
        "item-b",
      ]);
      for (const outcome of stopped) {
        assert.equal(outcome.ok, false);
        assert.equal(outcome.value, null);
        assert.ok(
          outcome.skippedReason?.startsWith("run budget exceeded"),
          outcome.skippedReason ?? "",
        );
      }

      const underRun = new BudgetLedger(repo, "run_under", {
        perTaskTokens: null,
        perTaskCostUsd: null,
        perRunTokens: 5,
        perRunCostUsd: null,
      });
      let ran = 0;
      const dispatched = await dispatchAll(
        [
          {
            id: "item-c",
            run: async (): Promise<string> => {
              ran += 1;
              return "c";
            },
          },
          {
            id: "item-d",
            run: async (): Promise<string> => {
              ran += 1;
              return "d";
            },
          },
        ],
        {
          maxWorkers: 2,
          leases,
          budget: underRun,
          logger: silentLogger,
          signal,
        },
      );
      assert.equal(ran, 2);
      assert.ok(
        dispatched.every((outcome) => outcome.ok && outcome.value !== null),
      );
    } finally {
      leases.releaseAll();
    }
  } finally {
    cleanup();
  }
});
