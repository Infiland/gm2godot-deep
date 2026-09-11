import { mutexPathsFor, writeRootsIntersect } from "../analysis/cycles.ts";
import type { TaskRecord } from "../storage/types.ts";

/**
 * Task ids each task must never run concurrently with, in either direction. Derived from two sources:
 * write allowlists that overlap, and the shared single-writer mutex paths (project settings, the GML
 * runtime and the managers) that two otherwise-independent tasks may still both need to touch.
 *
 * `reasons` is keyed by the pair `"<taskA>|<taskB>"` with the two ids sorted, so a task serialized
 * against several peers keeps one explanation per pair.
 */
export interface SerializationRequirements {
  readonly serialized: Readonly<Record<string, readonly string[]>>;
  readonly reasons: Readonly<Record<string, string>>;
}

export function serializationRequirements(tasks: readonly TaskRecord[]): SerializationRequirements {
  const serialized: Record<string, string[]> = {};
  const reasons: Record<string, string> = {};
  const mutexByTask: Record<string, readonly string[]> = {};
  for (const task of tasks) {
    serialized[task.id] = [];
    mutexByTask[task.id] = mutexPathsFor(task.allowlist.write);
  }

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      const writesOverlap = writeRootsIntersect(a.allowlist.write, b.allowlist.write);
      const sharedMutex = (mutexByTask[a.id] ?? []).filter((path) => (mutexByTask[b.id] ?? []).includes(path));
      if (!writesOverlap && sharedMutex.length === 0) continue;

      serialized[a.id]!.push(b.id);
      serialized[b.id]!.push(a.id);
      // The shared mutex is checked first because it is the only way two write roots can conflict
      // without one literally containing the other; if it is present it is the cause.
      const explanation =
        sharedMutex.length > 0
          ? `shared mutex path ${sharedMutex.join(", ")}`
          : "write allowlists intersect at a shared path";
      const [first, second] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      reasons[`${first}|${second}`] = explanation;
    }
  }

  return { serialized, reasons };
}

/** True when no running task is serialized against `taskId`, in either direction. */
export function canDispatch(
  taskId: string,
  running: readonly string[],
  requirements: SerializationRequirements,
): boolean {
  return running.every(
    (peer) =>
      !(requirements.serialized[taskId] ?? []).includes(peer) && !(requirements.serialized[peer] ?? []).includes(taskId),
  );
}
