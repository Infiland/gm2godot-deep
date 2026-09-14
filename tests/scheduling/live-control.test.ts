import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LeaseManager } from "../../src/scheduling/leases.ts";
import { dispatchAll } from "../../src/scheduling/scheduler.ts";
import {
  recoveryError,
  resultRecoveryError,
} from "../../src/scheduling/recovery.ts";
import { silentLogger } from "../../src/util/log.ts";
import { ZERO_USAGE } from "../../src/agents/runtime.ts";
import { tempRepo } from "../helpers/environment.ts";

test("live worker increases dispatch while busy, decreases drain without killing calls", async () => {
  const { repo, cleanup } = tempRepo("live-workers");
  const releases = new Map<number, () => void>();
  let limit = 1;
  const started: number[] = [];
  const waitFor = async (count: number): Promise<void> => {
    for (let i = 0; started.length < count && i < 100; i++) await delay(10);
    assert.equal(started.length, count);
  };
  try {
    const done = dispatchAll(
      Array.from({ length: 5 }, (_, id) => ({
        id: String(id),
        run: async () => {
          started.push(id);
          await new Promise<void>((resolve) => releases.set(id, resolve));
          return id;
        },
      })),
      {
        maxWorkers: 1,
        currentMaxWorkers: () => limit,
        leases: new LeaseManager(repo, "test"),
        budget: null,
        logger: silentLogger,
        signal: new AbortController().signal,
      },
    );
    await waitFor(1);
    limit = 3;
    await waitFor(3);
    limit = 1;
    releases.get(0)!();
    releases.get(1)!();
    await delay(150);
    assert.equal(
      started.length,
      3,
      "lowering limit must wait for remaining calls",
    );
    releases.get(2)!();
    await waitFor(4);
    releases.get(3)!();
    await waitFor(5);
    releases.get(4)!();
    assert.ok((await done).every((row) => row.ok));
    assert.equal(repo.listLeases().filter((lease) => lease.owner).length, 0);
  } finally {
    for (const release of releases.values()) release();
    cleanup();
  }
});

test("rate limits stop queued dispatch while already running success is retained", async () => {
  const { repo, cleanup } = tempRepo("live-recovery");
  const started: number[] = [];
  try {
    const outcomes = await dispatchAll(
      Array.from({ length: 5 }, (_, id) => ({
        id: String(id),
        run: async () => {
          started.push(id);
          if (id === 0) throw recoveryError("429 Too many requests")!;
          await delay(20);
          return id;
        },
      })),
      {
        maxWorkers: 2,
        stopOnError: (error) => recoveryError(error) !== null,
        leases: new LeaseManager(repo, "test"),
        budget: null,
        logger: silentLogger,
        signal: new AbortController().signal,
      },
    );
    assert.deepEqual(started, [0, 1]);
    assert.equal(outcomes.find((row) => row.id === "1")?.ok, true);
    assert.equal(
      outcomes.length,
      2,
      "unstarted tasks remain pending rather than becoming blockers",
    );
    assert.equal(repo.listLeases().filter((lease) => lease.owner).length, 0);
  } finally {
    cleanup();
  }
});

test("provider and budget failures are recoverable but semantic failures are not mislabelled rate limits", () => {
  assert.equal(
    recoveryError("429 quota exceeded")?.code,
    "HOST_PROVIDER_RATE_LIMITED",
  );
  assert.equal(
    recoveryError("401 Unauthorized")?.code,
    "HOST_PROVIDER_UNAVAILABLE",
  );
  assert.equal(recoveryError("unsupported shader syntax"), null);
  assert.equal(
    resultRecoveryError({
      outcome: "budget_exceeded",
      transcriptPath: "",
      events: [],
      usage: ZERO_USAGE,
    })?.code,
    "GM2DEEP-BUDGET-EXCEEDED",
  );
});
