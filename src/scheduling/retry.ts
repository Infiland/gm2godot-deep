import type { TaskRecord } from "../storage/types.ts";

export interface RetryPolicy {
  readonly maxTaskAttempts: number;
  readonly maxRepairAttempts: number;
}

export type RetryAction = "run" | "retry" | "give_up";

export interface RetryDecision {
  readonly action: RetryAction;
  readonly attempt: number;
  readonly reason: string;
  /** Failure evidence appended to the next prompt so a retry is not a blind repeat. */
  readonly context: readonly string[];
}

/** Model-call failures (no patch produced) may be retried up to `maxTaskAttempts`. */
export function decideModelRetry(task: TaskRecord, failureEvidence: readonly string[]): RetryDecision {
  if (task.attempt < task.maxAttempts) {
    return {
      action: "retry",
      attempt: task.attempt + 1,
      reason: `attempt ${task.attempt} of ${task.maxAttempts} did not produce an accepted patch`,
      context: failureEvidence,
    };
  }
  return {
    action: "give_up",
    attempt: task.attempt,
    reason: `attempt ${task.attempt} of ${task.maxAttempts} exhausted`,
    context: failureEvidence,
  };
}

export type RepairAction = "repair" | "blocked";

export interface RepairDecision {
  readonly action: RepairAction;
  readonly repairAttempt: number;
  readonly reason: string;
}

/**
 * Repair attempts are a separate budget from model retries. Exhausting it blocks the task with the full
 * evidence chain rather than rewriting again — an unbounded repair loop is how a port silently drifts.
 */
export function decideRepair(repairAttemptsSoFar: number, policy: RetryPolicy, failingChecks: readonly string[]): RepairDecision {
  if (repairAttemptsSoFar < policy.maxRepairAttempts) {
    return {
      action: "repair",
      repairAttempt: repairAttemptsSoFar + 1,
      reason: `repair attempt ${repairAttemptsSoFar + 1} of ${policy.maxRepairAttempts} for failing check(s): ${failingChecks.join(", ")}`,
    };
  }
  return {
    action: "blocked",
    repairAttempt: repairAttemptsSoFar,
    reason: `repair budget exhausted after ${policy.maxRepairAttempts} attempt(s); failing check(s): ${failingChecks.join(", ")}`,
  };
}

export function failureEvidenceFrom(
  events: readonly { kind: string; detail: unknown; at: string }[],
): readonly string[] {
  return events
    .filter((event) => event.kind === "failure" || event.kind === "check_failed" || event.kind === "policy_denied")
    .map((event) => `${event.at} ${event.kind}: ${JSON.stringify(event.detail).slice(0, 500)}`);
}
