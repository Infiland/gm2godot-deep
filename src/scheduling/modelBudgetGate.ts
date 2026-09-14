import { AgentUsageSchema } from "../evidence/schemas.ts";
import type { AgentRunRequest, AgentRunResult } from "../agents/runtime.ts";
import { DeepError } from "../util/result.ts";
import type { BudgetLedger } from "./budgets.ts";

const tokensOf = (usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): number => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
const minimum = (...limits: (number | null)[]): number | null => {
  const defined = limits.filter((value): value is number => value !== null);
  return defined.length ? Math.min(...defined) : null;
};

/** Reserve each task's maximum spend before concurrent dispatch, releasing unused allowance on completion. */
export class ModelBudgetGate {
  readonly ledger: BudgetLedger;
  readonly zeroCost: boolean;
  private reservedTokens = 0;
  private reservedCost = 0;
  private active = 0;
  private readonly waiters = new Set<() => void>();
  constructor(ledger: BudgetLedger, zeroCost = false) {
    this.ledger = ledger;
    this.zeroCost = zeroCost;
  }

  async run(
    request: AgentRunRequest,
    execute: (request: AgentRunRequest) => Promise<AgentRunResult>,
  ): Promise<AgentRunResult> {
    const allowance = await this.reserve(request);
    let charged = false;
    try {
      const result = await execute({ ...request, budgets: allowance });
      charged = true;
      if ("usageUncertain" in result && result.usageUncertain === true) {
        const known = result.usage;
        this.ledger.charge(request.taskId, {
          ...known,
          input:
            known.input +
            Math.max(0, (allowance.tokens ?? 0) - tokensOf(known)),
          costUsd: Math.max(known.costUsd, allowance.costUsd ?? 0),
          reported: false,
        });
        this.ledger.repo.recordInvalidation({
          kind: "budget_usage_uncertain",
          unitId: request.taskId,
          detail: {
            reason:
              "Provider reported incomplete usage; reserved allowance charged as an unreported upper bound",
            allowance,
            knownUsage: known,
          },
        });
      } else this.ledger.charge(request.taskId, result.usage);
      return result;
    } catch (error) {
      if (!charged) {
        const parsed = AgentUsageSchema.safeParse(
          typeof error === "object" && error !== null && "usage" in error
            ? error.usage
            : undefined,
        );
        const usage = parsed.success
          ? parsed.data
          : {
              input: allowance.tokens ?? 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              costUsd: allowance.costUsd ?? 0,
              reported: false,
            };
        this.ledger.charge(request.taskId, usage);
        if (!parsed.success)
          this.ledger.repo.recordInvalidation({
            kind: "budget_usage_uncertain",
            unitId: request.taskId,
            detail: {
              reason:
                "Provider invocation threw without usage; reserved allowance charged as an unreported upper bound",
              allowance,
            },
          });
      }
      throw error;
    } finally {
      this.reservedTokens -= allowance.tokens ?? 0;
      this.reservedCost -= allowance.costUsd ?? 0;
      this.active--;
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }
  }
  private async reserve(
    request: AgentRunRequest,
  ): Promise<{ tokens: number | null; costUsd: number | null }> {
    for (;;) {
      request.signal.throwIfAborted();
      const current = this.ledger.decide(request.taskId),
        ceilings = this.ledger.ceilings;
      if (current.exceeded)
        throw new DeepError(
          "GM2DEEP-BUDGET-EXCEEDED",
          `${current.reason}; increase the paused job budget to resume`,
        );
      const taskTokens =
        ceilings.perTaskTokens === null
          ? null
          : ceilings.perTaskTokens - tokensOf(current.task);
      const taskCost =
        ceilings.perTaskCostUsd === null
          ? null
          : ceilings.perTaskCostUsd - current.task.costUsd;
      const remainingTokens =
        ceilings.perRunTokens === null
          ? null
          : ceilings.perRunTokens - tokensOf(current.run);
      const remainingCost =
        ceilings.perRunCostUsd === null
          ? null
          : ceilings.perRunCostUsd - current.run.costUsd;
      if (
        (taskTokens !== null && taskTokens <= 0) ||
        (!this.zeroCost && taskCost !== null && taskCost <= 0)
      )
        throw new DeepError(
          "GM2DEEP-BUDGET-EXCEEDED",
          "Task budget exhausted; increase per-task limits before resuming",
        );
      if (
        (remainingTokens !== null && remainingTokens <= 0) ||
        (!this.zeroCost && remainingCost !== null && remainingCost <= 0)
      )
        throw new DeepError(
          "GM2DEEP-BUDGET-EXCEEDED",
          "Job budget exhausted; increase the paused job budget to resume",
        );
      const tokens = minimum(
        request.budgets.tokens,
        taskTokens,
        remainingTokens === null ? null : remainingTokens - this.reservedTokens,
      );
      const costUsd = this.zeroCost
        ? 0
        : minimum(
            request.budgets.costUsd,
            taskCost,
            remainingCost === null ? null : remainingCost - this.reservedCost,
          );
      if (
        (tokens === null || tokens > 0) &&
        (this.zeroCost || costUsd === null || costUsd > 0)
      ) {
        this.reservedTokens += tokens ?? 0;
        this.reservedCost += costUsd ?? 0;
        this.active++;
        return { tokens, costUsd };
      }
      if (!this.active)
        throw new DeepError(
          "GM2DEEP-BUDGET-EXCEEDED",
          "No model budget remains; increase the paused job budget to resume",
        );
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          request.signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = (): void => {
          this.waiters.delete(wake);
          reject(request.signal.reason);
        };
        this.waiters.add(wake);
        request.signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
