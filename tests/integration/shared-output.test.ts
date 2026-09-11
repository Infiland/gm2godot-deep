import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canDispatch, serializationRequirements } from "../../src/integration/conflicts.ts";
import { publishPatch } from "../../src/integration/publish.ts";
import { PatchRecordPayloadSchema } from "../../src/evidence/schemas.ts";
import { dispatchAll, type DispatchItem } from "../../src/scheduling/scheduler.ts";
import { LeaseManager } from "../../src/scheduling/leases.ts";
import { createLogger } from "../../src/util/log.ts";
import type { TaskRecord } from "../../src/storage/types.ts";
import { createTestWorkspace, hashBytes, insertTask } from "../helpers/harness.ts";

const PORT_STATE = "gm2godot/scripts/shared/state.gd";
const MOCK_PRODUCED_BY = {
  runtime: "mock",
  simulated: true,
  promptVersion: "1",
  schemaVersion: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, reported: false },
} as const;

/**
 * Serializes publications exactly like the scheduler's single-writer port mutex. The gate is what keeps
 * two tasks out of this critical section at once; the mutex would turn a gate bug into a revision race.
 */
function createMutex(): <T>(body: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(body: () => Promise<T>): Promise<T> => {
    const previous = tail;
    const { promise, resolve } = Promise.withResolvers<void>();
    tail = promise;
    await previous;
    try {
      return await body();
    } finally {
      resolve();
    }
  };
}

test("tasks that share a generated path are never dispatched concurrently and publish serialized", async () => {
  const ws = createTestWorkspace("shared-output");
  try {
    const tasks: TaskRecord[] = [
      insertTask(ws.repo, { id: "A", state: "PLANNED", write: ["gm2godot/scripts/shared/**"] }),
      insertTask(ws.repo, { id: "B", state: "PLANNED", write: ["gm2godot/scripts/shared/**"] }),
      insertTask(ws.repo, { id: "C", state: "PLANNED", write: ["addons/gm2godot_extensions/**"] }),
      insertTask(ws.repo, { id: "D", state: "PLANNED", write: ["gm2godot/managers/event_scheduler.gd"] }),
      insertTask(ws.repo, { id: "E", state: "PLANNED", write: ["gm2godot/managers/state_owner.gd"] }),
    ];

    const requirements = serializationRequirements(tasks);
    assert.deepEqual(requirements.serialized["A"], ["B"]);
    assert.deepEqual(requirements.serialized["B"], ["A"]);
    assert.equal(requirements.serialized["C"]?.length, 0);
    assert.deepEqual(requirements.serialized["D"], ["E"]);
    assert.deepEqual(requirements.serialized["E"], ["D"]);
    assert.match(requirements.reasons["A|B"] ?? "", /write allowlists intersect/);
    // D and E write disjoint files, so only the jointly-managed mutex path can explain this pair.
    assert.equal(requirements.reasons["D|E"], "shared mutex path gm2godot/managers");

    const running = new Set<string>();
    /** For each task, the peers it observed running while it was itself running. */
    const coRanWith: Record<string, string[]> = {};
    const runs: Record<string, number> = {};
    const portMutex = createMutex();
    const logger = createLogger({ stderr: () => {} });

    const items: DispatchItem<string>[] = tasks.map((task) => ({
      id: task.id,
      run: async (): Promise<string> => {
        runs[task.id] = (runs[task.id] ?? 0) + 1;
        running.add(task.id);
        try {
          // Yield once so every worker that is allowed to start has started before any body finishes.
          // The peers seen here are peers that really ran at the same time; no wall-clock waiting.
          await Promise.resolve();
          coRanWith[task.id] = [...running].filter((peer) => peer !== task.id).sort();

          if (task.id === "A" || task.id === "B") {
            const content = task.id === "A" ? "v1\n" : "v2\n";
            await portMutex(async () => {
              const payload = PatchRecordPayloadSchema.parse({
                schemaVersion: 1,
                taskId: task.id,
                attempt: 1,
                basePortRevision: ws.repo.currentPortRevision(),
                inputHash: task.inputHash,
                contractVersions: {},
                files: [
                  {
                    path: PORT_STATE,
                    action: task.id === "A" ? "create" : "update",
                    preimageSha256: task.id === "A" ? null : hashBytes("v1\n"),
                    contentSha256: hashBytes(content),
                    content,
                  },
                ],
                summary: `publish ${content.trim()}`,
                producedBy: MOCK_PRODUCED_BY,
              });
              publishPatch({
                repo: ws.repo,
                portDir: ws.workspace.paths.port,
                task,
                payload,
                files: [PORT_STATE],
              });
            });
          }
          return task.id;
        } finally {
          running.delete(task.id);
        }
      },
    }));

    const pending = new Set(tasks.map((task) => task.id));
    const skippedByWave: string[][] = [];
    for (let wave = 0; wave < 10 && pending.size > 0; wave += 1) {
      const batch = items.filter((item) => pending.has(item.id));
      const outcomes = await dispatchAll(batch, {
        maxWorkers: 8,
        leases: new LeaseManager(ws.repo, `test-owner-${String(wave)}`),
        budget: null,
        logger,
        signal: new AbortController().signal,
        canDispatch: (item) => {
          const allowed = canDispatch(item.id, [...running], requirements);
          return { allowed, reason: allowed ? null : `serialized against a running task: ${item.id}` };
        },
      });
      skippedByWave.push(
        outcomes
          .filter((outcome) => outcome.skippedReason !== null)
          .map((outcome) => outcome.id)
          .sort(),
      );
      for (const outcome of outcomes) {
        if (outcome.ok) {
          pending.delete(outcome.id);
          continue;
        }
        if (outcome.skippedReason !== null) continue; // serialized against a running peer: retry next wave
        throw outcome.error ?? new Error(`task ${outcome.id} failed without an error`);
      }
    }
    assert.equal(pending.size, 0, `tasks never dispatched: ${[...pending].join(", ")}`);

    // Wave 1 must deny exactly the two peers whose write roots are shared, before their bodies start.
    assert.deepEqual(skippedByWave[0], ["B", "E"]);
    for (const task of tasks) assert.equal(runs[task.id], 1, `${task.id} ran more than once`);

    assert.equal(coRanWith["A"]?.includes("B") ?? false, false, "A overlapped B");
    assert.equal(coRanWith["B"]?.includes("A") ?? false, false, "B overlapped A");
    assert.equal(coRanWith["D"]?.includes("E") ?? false, false, "D overlapped E");
    assert.equal(coRanWith["E"]?.includes("D") ?? false, false, "E overlapped D");
    assert.equal(
      (coRanWith["C"] ?? []).includes("A"),
      true,
      `C is independent of A and must run concurrently with it; C saw ${JSON.stringify(coRanWith["C"])}`,
    );

    // Both publishings happened, in order, and the port holds the second one.
    assert.equal(readFileSync(join(ws.workspace.paths.port, PORT_STATE), "utf8"), "v2\n");
    assert.equal(ws.repo.currentPortRevision(), 2);
    assert.equal(ws.repo.listIntegrations().length, 2);
  } finally {
    ws.cleanup();
  }
});
