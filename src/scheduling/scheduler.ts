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
  readonly currentMaxWorkers?: () => number;
  readonly stopOnError?: (error: unknown) => boolean;
  readonly leases: LeaseManager;
  readonly budget: BudgetLedger | null;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** Called as each item settles, so a caller can persist progress incrementally. */
  readonly onSettled?: (outcome: DispatchOutcome<T>) => void | Promise<void>;
  /** Consulted before each dispatch; a `false` result stops dispatching new work. */
  readonly canDispatch?: (item: DispatchItem<T>) => {
    allowed: boolean;
    reason: string | null;
  };
}

/**
 * Bounded worker pool with leases and budget checks. A task whose lease is held elsewhere is reported as
 * skipped rather than run twice; a budget that is already exceeded stops new dispatches without aborting
 * work that is in flight.
 */
export async function dispatchAll<T>(
  items: readonly DispatchItem<T>[],
  options: DispatchOptions<T>,
): Promise<DispatchOutcome<T>[]> {
  const results: DispatchOutcome<T>[] = [];
  const queue = [...items];
  let stopped: string | null = null;

  const settle = async (outcome: DispatchOutcome<T>): Promise<void> => {
    results.push(outcome);
    await options.onSettled?.(outcome);
  };

  const execute = async (item: DispatchItem<T>): Promise<void> => {
    if (options.budget !== null) {
      const decision = options.budget.decide(null);
      if (decision.exceeded)
        stopped = `run budget exceeded: ${decision.reason ?? "unknown"}`;
    }
    if (stopped !== null) {
      await settle({
        id: item.id,
        ok: false,
        value: null,
        error: null,
        skippedReason: stopped,
      });
      return;
    }
    const gate = options.canDispatch?.(item);
    if (gate !== undefined && !gate.allowed) {
      await settle({
        id: item.id,
        ok: false,
        value: null,
        error: null,
        skippedReason: gate.reason ?? "not dispatchable",
      });
      return;
    }
    if (!options.leases.acquire(item.id)) {
      await settle({
        id: item.id,
        ok: false,
        value: null,
        error: null,
        skippedReason: "lease held by another worker",
      });
      return;
    }
    try {
      const value = await item.run(options.signal);
      await settle({
        id: item.id,
        ok: true,
        value,
        error: null,
        skippedReason: null,
      });
    } catch (error) {
      if (
        options.stopOnError?.(error) ||
        (error instanceof DeepError && error.code === "GM2DEEP-BUDGET-EXCEEDED")
      )
        stopped = error instanceof Error ? error.message : String(error);
      await settle({
        id: item.id,
        ok: false,
        value: null,
        error,
        skippedReason: null,
      });
    } finally {
      options.leases.release(item.id);
    }
  };
  const active = new Set<Promise<void>>();
  const capacity = (): number =>
    Math.max(
      1,
      Math.min(32, options.currentMaxWorkers?.() ?? options.maxWorkers),
    );
  options.logger.debug(
    `dispatching ${items.length} item(s) with ${capacity()} worker(s)`,
  );
  while (queue.length || active.size) {
    while (
      queue.length &&
      !stopped &&
      !options.signal.aborted &&
      active.size < capacity()
    ) {
      const item = queue.shift()!;
      const pending = execute(item).finally(() => active.delete(pending));
      active.add(pending);
    }
    if (!active.size) break;
    // Wake periodically to apply a raised limit even when every current model is still busy.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ...active,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 100);
      }),
    ]);
    clearTimeout(timer);
  }
  // Unstarted work remains pending on recoverable stops and is durably reconstructed on resume.
  if (stopped && !options.stopOnError)
    for (const item of queue)
      await settle({
        id: item.id,
        ok: false,
        value: null,
        error: null,
        skippedReason: stopped,
      });
  return results;
}
