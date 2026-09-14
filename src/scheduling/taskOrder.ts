import type { TaskRecord } from "../storage/types.ts";
import { DeepError } from "../util/result.ts";

/** Stable dependency ordering; grouped cycles should already have been resolved by planning. */
export function orderTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ordered: TaskRecord[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (task: TaskRecord): void => {
    if (done.has(task.id)) return;
    if (visiting.has(task.id))
      throw new DeepError(
        "GM2DEEP-PLAN-CYCLE",
        `Unresolved implementation dependency cycle at ${task.id}`,
      );
    visiting.add(task.id);
    for (const id of task.dependsOn) {
      const dependency = byId.get(id);
      if (dependency) visit(dependency);
    }
    visiting.delete(task.id);
    done.add(task.id);
    ordered.push(task);
  };
  for (const task of tasks) visit(task);
  return ordered;
}
