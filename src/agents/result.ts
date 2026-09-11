import { ZERO_USAGE, type AgentOutcome, type Usage } from "./runtime.ts";

/**
 * The subset of `@earendil-works/pi-ai`'s `Usage` this module consumes. Providers report a
 * structurally-present `usage` object whose numbers may all be zero; `cost.total` may be absent for a
 * provider that does not price its responses.
 */
export interface UsageLike {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens?: number;
  readonly cost?: { readonly total?: number };
}

/** A token and cost ceiling. `null` disables that ceiling. Mirrors `AgentRunRequest["budgets"]`. */
export interface UsageCeilings {
  readonly tokens: number | null;
  readonly costUsd: number | null;
}

/** Terminal conditions observed while a run was active. */
export interface RunLimits extends UsageCeilings {
  readonly aborted: boolean;
  readonly timedOut: boolean;
}

/** A fresh zeroed usage. `reported: false` until a provider supplies a non-zero counter. */
export function emptyUsage(): Usage {
  return { ...ZERO_USAGE };
}

function counted(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Whether the provider supplied any non-zero counter (or a positive cost) for this message. */
function providerReported(incoming: UsageLike | undefined): boolean {
  if (incoming === undefined) return false;
  return (
    counted(incoming.input) ||
    counted(incoming.output) ||
    counted(incoming.cacheRead) ||
    counted(incoming.cacheWrite) ||
    counted(incoming.totalTokens) ||
    counted(incoming.cost?.total)
  );
}

function atLeast(current: number, next: number | undefined): number {
  return next === undefined || !Number.isFinite(next) ? current : Math.max(current, next);
}

/**
 * Fold one provider message's usage into the run's usage.
 *
 * Each counter keeps the **maximum** seen, never the sum across turns: a provider reports per-request
 * usage, and summing it would double-count the cached prefix every turn while still being unable to
 * reconstruct the true prompt cost. The maximum is therefore a floor on real usage — never an invented
 * number — and `reported` records whether the provider supplied anything at all. Callers that need a
 * cumulative figure must not read one out of this type.
 */
export function mergeUsage(target: Usage, incoming: UsageLike | undefined): Usage {
  return {
    input: atLeast(target.input, incoming?.input),
    output: atLeast(target.output, incoming?.output),
    cacheRead: atLeast(target.cacheRead, incoming?.cacheRead),
    cacheWrite: atLeast(target.cacheWrite, incoming?.cacheWrite),
    costUsd: atLeast(target.costUsd, incoming?.cost?.total),
    reported: target.reported || providerReported(incoming),
  };
}

/** The token total a ceiling applies to: every counter the provider reported. */
function usedTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Whether either ceiling has been crossed by the usage recorded so far. */
export function budgetExceeded(usage: Usage, ceilings: UsageCeilings): boolean {
  if (ceilings.tokens !== null && usedTokens(usage) > ceilings.tokens) return true;
  if (ceilings.costUsd !== null && usage.costUsd > ceilings.costUsd) return true;
  return false;
}

/**
 * Reduce a finished run to its outcome:
 * - `budget_exceeded` when an enabled ceiling was crossed by the recorded usage;
 * - `aborted` / `timeout` when the caller's signal fired or the wall clock expired;
 * - `no_result` when no successful result-tool payload was captured — prose never counts as a result;
 * - `completed` otherwise. The caller validates `captured` against the role schema and downgrades a
 *   violation to `failed` itself.
 */
export function outcomeFrom(captured: unknown, usage: Usage, limits: RunLimits): AgentOutcome {
  if (budgetExceeded(usage, limits)) return "budget_exceeded";
  if (limits.aborted) return "aborted";
  if (limits.timedOut) return "timeout";
  if (captured === undefined) return "no_result";
  return "completed";
}
