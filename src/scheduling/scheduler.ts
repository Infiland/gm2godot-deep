import { DeepError } from "../util/result.ts";
import type { Logger } from "../util/log.ts";
import type { BudgetLedger } from "./budgets.ts";
import type { LeaseManager } from "./leases.ts";

export interface DispatchItem<T> {
  readonly id: string;
  run(signal: AbortSignal): Promise<T>;
}

export interface DispatchOutcome<T> {
  readonly id: string;
  readonly ok: boolean;
  readonly value: T | null;
  readonly error: unknown;
  readonly skippedReason: string | null;
}

export interface DispatchOptions<T> {
  readonly maxWorkers: number;
  readonly leases: LeaseManager;
  readonly budget: BudgetLedger | null;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** Called as each item settles, so a caller can persist progress incrementally. */
  readonly onSettled?: (outcome: DispatchOutcome<T>) => void | Promise<void>;
  /** Consulted before each dispatch; a `false` result stops dispatching new work. */
  readonly canDispatch?: (item: DispatchItem<T>) => { allowed: boolean; reason: string | null };
}

/**
 * Bounded worker pool with leases and budget checks. A task whose lease is held elsewhere is reported as
 * skipped rather than run twice; a budget that is already exceeded stops new dispatches without aborting
 * work that is in flight.
 */
export async function dispatchAll<T>(items: readonly DispatchItem<T>[], options: DispatchOptions<T>): Promise<DispatchOutcome<T>[]> {
  const results: DispatchOutcome<T>[] = [];
  const queue = [...items];
  let stopped: string | null = null;

  const settle = async (outcome: DispatchOutcome<T>): Promise<void> => {
    results.push(outcome);
    await options.onSettled?.(outcome);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal.aborted) return;
      const item = queue.shift();
      if (item === undefined) return;

      if (stopped !== null) {
        await settle({ id: item.id, ok: false, value: null, error: null, skippedReason: stopped });
        continue;
      }
      if (options.budget !== null) {
        const decision = options.budget.decide(null);
        if (decision.exceeded) {
          stopped = `run budget exceeded: ${decision.reason ?? "unknown"}`;
          await settle({ id: item.id, ok: false, value: null, error: null, skippedReason: stopped });
          continue;
        }
      }
      const gate = options.canDispatch?.(item);
      if (gate !== undefined && !gate.allowed) {
        await settle({ id: item.id, ok: false, value: null, error: null, skippedReason: gate.reason ?? "not dispatchable" });
        continue;
      }
      if (!options.leases.acquire(item.id)) {
        await settle({ id: item.id, ok: false, value: null, error: null, skippedReason: "lease held by another worker" });
        continue;
      }
      try {
        const value = await item.run(options.signal);
        await settle({ id: item.id, ok: true, value, error: null, skippedReason: null });
      } catch (error) {
        await settle({ id: item.id, ok: false, value: null, error, skippedReason: null });
        if (error instanceof DeepError && error.code === "GM2DEEP-BUDGET-EXCEEDED") {
          stopped = error.message;
        }
      } finally {
        options.leases.release(item.id);
      }
    }
  };

  const workers = Math.max(1, Math.min(options.maxWorkers, items.length));
  if (items.length === 0) return results;
  options.logger.debug(`dispatching ${items.length} item(s) with ${workers} worker(s)`);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
