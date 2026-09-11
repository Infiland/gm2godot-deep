import { DeepError } from "../util/result.ts";
import type { Repo } from "../storage/repo.ts";
import type { LeaseRecord } from "../storage/types.ts";
import { TaskMachine } from "./machine.ts";

export const DEFAULT_LEASE_TTL_SECONDS = 120;

/**
 * Task leases make a crashed run recoverable without risking two workers on the same task: a worker that
 * dies leaves an expired lease behind, and `reclaimExpired` is the only thing that returns those tasks to
 * READY.
 */
export class LeaseManager {
  readonly repo: Repo;
  readonly owner: string;
  readonly ttlSeconds: number;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(repo: Repo, owner: string, ttlSeconds = DEFAULT_LEASE_TTL_SECONDS) {
    this.repo = repo;
    this.owner = owner;
    this.ttlSeconds = ttlSeconds;
  }

  acquire(taskId: string): boolean {
    this.repo.ensureLeaseRow(taskId);
    const acquired = this.repo.acquireLease(taskId, this.owner, this.ttlSeconds);
    if (!acquired) return false;
    if (!this.timers.has(taskId)) {
      const interval = setInterval(
        () => {
          this.repo.heartbeatLease(taskId, this.owner, this.ttlSeconds);
        },
        Math.max(250, Math.floor((this.ttlSeconds * 1000) / 3)),
      );
      interval.unref?.();
      this.timers.set(taskId, interval);
    }
    return true;
  }

  release(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(taskId);
    }
    this.repo.releaseLease(taskId, this.owner);
  }

  releaseAll(): void {
    for (const taskId of [...this.timers.keys()]) this.release(taskId);
  }

  held(): LeaseRecord[] {
    return this.repo.listLeases().filter((lease) => lease.owner === this.owner);
  }
}

export interface ReclaimOutcome {
  readonly machine: TaskMachine;
  readonly reclaimed: readonly { taskId: string; previousOwner: string | null }[];
}

/**
 * Return tasks whose lease expired while RUNNING to READY with `attempt + 1`, recording a `lease_expired`
 * event. This is the crash-recovery path; `resume` is the only thing that calls it.
 */
export function reclaimExpired(repo: Repo, now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")): ReclaimOutcome {
  const machine = new TaskMachine(repo);
  const reclaimed: { taskId: string; previousOwner: string | null }[] = [];
  for (const lease of repo.expiredLeases(now)) {
    const task = repo.getTask(lease.taskId);
    if (task === null) throw new DeepError("GM2DEEP-TASK-MISSING", `lease references unknown task ${lease.taskId}`);
    if (task.state !== "RUNNING") {
      repo.releaseLease(lease.taskId, lease.owner ?? "");
      continue;
    }
    repo.releaseLease(lease.taskId, lease.owner ?? "");
    machine.transition(lease.taskId, "READY", {
      reason: "resume",
      eventKind: "lease_expired",
      detail: { previousOwner: lease.owner, expiresAt: lease.expiresAt },
    });
    reclaimed.push({ taskId: lease.taskId, previousOwner: lease.owner });
  }
  return { machine, reclaimed };
}

/** `resume --retry-blocked` / `--retry-failed`: explicit, recorded, never automatic. */
export function retryStuckTasks(
  repo: Repo,
  states: readonly ("BLOCKED" | "FAILED" | "CANCELLED")[],
  reason: "resume" | "retry" = "retry",
): readonly string[] {
  const machine = new TaskMachine(repo);
  const moved: string[] = [];
  for (const state of states) {
    for (const task of repo.listTasksInState(state)) {
      machine.transition(task.id, "READY", { reason, detail: { from: state } });
      moved.push(task.id);
    }
  }
  return moved;
}
