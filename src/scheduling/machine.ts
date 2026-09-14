import { DeepError } from "../util/result.ts";
import { transact, type Database } from "../storage/db.ts";
import type { Repo } from "../storage/repo.ts";
import type { TaskState } from "../storage/types.ts";

/** The transition table. Any edge not listed here is a programming error, not a runtime condition. */
export const LEGAL_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  DISCOVERED: ["ANALYZED", "BLOCKED", "CANCELLED"],
  ANALYZED: ["PLANNED", "BLOCKED", "CANCELLED"],
  PLANNED: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["IMPLEMENTED", "FAILED", "BLOCKED", "CANCELLED"],
  IMPLEMENTED: ["VALIDATING", "CANCELLED"],
  VALIDATING: ["ACCEPTED", "REPAIR_REQUIRED", "FAILED", "BLOCKED", "CANCELLED"],
  REPAIR_REQUIRED: ["RUNNING", "BLOCKED", "FAILED", "CANCELLED"],
  ACCEPTED: ["READY"],
  BLOCKED: ["READY"],
  FAILED: ["READY"],
  CANCELLED: ["READY"],
};

/** Edges that only a recorded reason may take, so a silent re-run cannot look like progress. */
export const REASON_REQUIRED: readonly string[] = [
  "ACCEPTED->READY",
  "BLOCKED->READY",
  "FAILED->READY",
  "CANCELLED->READY",
];

export type TransitionReason = "invalidation" | "resume" | "retry";

export class IllegalTransitionError extends DeepError {
  constructor(from: TaskState, to: TaskState) {
    super("GM2DEEP-ILLEGAL-TRANSITION", `cannot move from ${from} to ${to}`, {
      from,
      to,
    });
    this.name = "IllegalTransitionError";
  }
}

export interface TransitionOptions {
  readonly detail?: unknown;
  readonly reason?: TransitionReason;
  /** Increment the attempt counter as part of this transition (entering RUNNING or REPAIR_REQUIRED). */
  readonly incrementAttempt?: boolean;
  readonly eventKind?: string;
}

/**
 * Every state change in the system goes through here. The state write and the `task_events` append happen
 * in one transaction, so a crash can never leave a task moved without a record of why.
 */
export class TaskMachine {
  readonly repo: Repo;

  readonly onTransition:
    | ((
        taskId: string,
        state: TaskState,
        attempt: number,
        detail: unknown,
      ) => void)
    | undefined;
  constructor(
    repo: Repo,
    onTransition?: (
      taskId: string,
      state: TaskState,
      attempt: number,
      detail: unknown,
    ) => void,
  ) {
    this.repo = repo;
    this.onTransition = onTransition;
  }

  static canTransition(from: TaskState, to: TaskState): boolean {
    return LEGAL_TRANSITIONS[from].includes(to);
  }

  transition(
    taskId: string,
    to: TaskState,
    options: TransitionOptions = {},
  ): void {
    const task = this.repo.getTask(taskId);
    if (task === null)
      throw new DeepError("GM2DEEP-TASK-MISSING", `no task ${taskId}`);
    const from = task.state;
    if (!TaskMachine.canTransition(from, to))
      throw new IllegalTransitionError(from, to);
    const edge = `${from}->${to}`;
    if (REASON_REQUIRED.includes(edge) && options.reason === undefined) {
      throw new DeepError(
        "GM2DEEP-TRANSITION-REASON-REQUIRED",
        `${edge} requires a recorded reason`,
        { edge },
      );
    }

    const attempt =
      options.incrementAttempt === true ? task.attempt + 1 : task.attempt;
    transact(this.repo.db as Database, () => {
      this.repo.db
        .prepare(
          "UPDATE tasks SET state = ?, attempt = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          to,
          attempt,
          new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          taskId,
        );
      this.repo.appendEvent({
        taskId,
        kind: options.eventKind ?? "state",
        fromState: from,
        toState: to,
        attempt,
        detail: {
          ...(typeof options.detail === "object" && options.detail !== null
            ? options.detail
            : { detail: options.detail }),
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        },
      });
    });
    this.onTransition?.(taskId, to, attempt, options.detail);
  }

  /** Record a non-transition fact (policy denial, lease expiry, review verdict) against a task. */
  record(taskId: string, kind: string, detail?: unknown): void {
    this.repo.appendEvent({ taskId, kind, detail });
  }
}
