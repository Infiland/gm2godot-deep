import { DeepError } from "../util/result.ts";
import type { Repo } from "../storage/repo.ts";
import type { UsageTotals } from "../storage/types.ts";

export interface BudgetCeilings {
  readonly perTaskTokens: number | null;
  readonly perTaskCostUsd: number | null;
  readonly perRunTokens: number | null;
  readonly perRunCostUsd: number | null;
}

export interface BudgetDecision {
  readonly exceeded: boolean;
  readonly scope: "task" | "run" | null;
  readonly reason: string | null;
  readonly run: UsageTotals;
  readonly task: UsageTotals;
}

function tokensOf(usage: UsageTotals): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Per-run and per-task ceilings. A provider that reports no usage still counts as zero cost, but the
 * decision records that the provider reported nothing, so the report can say so instead of implying a
 * measured zero.
 */
export class BudgetLedger {
  readonly repo: Repo;
  readonly runId: string;
  readonly ceilings: BudgetCeilings;

  constructor(repo: Repo, runId: string, ceilings: BudgetCeilings) {
    this.repo = repo;
    this.runId = runId;
    this.ceilings = ceilings;
  }

  charge(taskId: string | null, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; reported: boolean }): BudgetDecision {
    this.repo.charge({ runId: this.runId, taskId, ...usage });
    return this.decide(taskId);
  }

  decide(taskId: string | null): BudgetDecision {
    const run = this.repo.totalsForRun(this.runId);
    const task = taskId === null ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, reported: false } : this.repo.totalsForTask(taskId);
    const taskTokens = tokensOf(task);
    const runTokens = tokensOf(run);

    if (taskId !== null && this.ceilings.perTaskTokens !== null && taskTokens > this.ceilings.perTaskTokens) {
      return {
        exceeded: true,
        scope: "task",
        reason: `task used ${taskTokens} tokens, above the ${this.ceilings.perTaskTokens} token ceiling${task.reported ? "" : " (provider did not report usage; counters are the host's own)"}`,
        run,
        task,
      };
    }
    if (taskId !== null && this.ceilings.perTaskCostUsd !== null && task.costUsd > this.ceilings.perTaskCostUsd) {
      return {
        exceeded: true,
        scope: "task",
        reason: `task cost $${task.costUsd.toFixed(4)}, above the $${this.ceilings.perTaskCostUsd} ceiling`,
        run,
        task,
      };
    }
    if (this.ceilings.perRunTokens !== null && runTokens > this.ceilings.perRunTokens) {
      return {
        exceeded: true,
        scope: "run",
        reason: `run used ${runTokens} tokens, above the ${this.ceilings.perRunTokens} token ceiling`,
        run,
        task,
      };
    }
    if (this.ceilings.perRunCostUsd !== null && run.costUsd > this.ceilings.perRunCostUsd) {
      return {
        exceeded: true,
        scope: "run",
        reason: `run cost $${run.costUsd.toFixed(4)}, above the $${this.ceilings.perRunCostUsd} ceiling`,
        run,
        task,
      };
    }
    return { exceeded: false, scope: null, reason: null, run, task };
  }

  assertNotExceeded(taskId: string | null): void {
    const decision = this.decide(taskId);
    if (decision.exceeded) {
      throw new DeepError("GM2DEEP-BUDGET-EXCEEDED", decision.reason ?? "budget exceeded", {
        scope: decision.scope,
        run: decision.run,
        task: decision.task,
      });
    }
  }
}

export function ceilingsFrom(config: {
  agent: { budgets: { perTaskTokens: number | null; perTaskCostUsd: number | null; perRunTokens: number | null; perRunCostUsd: number | null } };
}): BudgetCeilings {
  return {
    perTaskTokens: config.agent.budgets.perTaskTokens,
    perTaskCostUsd: config.agent.budgets.perTaskCostUsd,
    perRunTokens: config.agent.budgets.perRunTokens,
    perRunCostUsd: config.agent.budgets.perRunCostUsd,
  };
}
