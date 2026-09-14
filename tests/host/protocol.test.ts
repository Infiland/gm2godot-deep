import { updateResumeSettings } from "../../src/host/settings.ts";
import { openWorkspace } from "../../src/workspaces/workspace.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thawTree } from "../../src/workspaces/snapshot.ts";
import { HostService } from "../../src/host/service.ts";
import {
  RequestSchema,
  ResearchParamsSchema,
  type HostEvent,
} from "../../src/host/protocol.ts";
import { prepareHostJob, verifyHostInputs } from "../../src/host/prepare.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "deep-host-"));
  const source = join(root, "source"),
    baseline = join(root, "baseline");
  mkdirSync(source);
  mkdirSync(baseline);
  writeFileSync(join(source, "demo.yyp"), '{"resources":[]}');
  writeFileSync(join(baseline, "project.godot"), "config_version=5\n");
  const snapshot = join(root, "host.json");
  writeFileSync(
    snapshot,
    JSON.stringify({
      schemaVersion: 1,
      gm2godotVersion: "1.0.0",
      gmlApiEntries: [],
      inventory: {
        project: {
          name: "demo",
          yypPath: "demo.yyp",
          ideVersion: "2024.1",
          resourceType: "GMProject",
          resourceVersion: "2.0",
        },
        resources: [],
        objects: [],
        rooms: [],
        scripts: [],
        sprites: [],
        shaders: [],
        extensions: [],
        diagnostics: [],
      },
    }),
  );
  const params = ResearchParamsSchema.parse({
    jobRoot: join(root, "job"),
    sourcePath: source,
    baselinePath: baseline,
    hostSnapshotPath: snapshot,
    settings: { runtime: "mock", provider: "", model: "mock" },
  });
  return { root, params };
}

test("host protocol rejects unknown versions and free workers default to one during preparation", async () => {
  assert.throws(() =>
    RequestSchema.parse({
      protocolVersion: 2,
      id: "1",
      method: "capabilities",
    }),
  );
  const f = fixture();
  try {
    const workspace = await prepareHostJob({
      ...f.params,
      settings: { ...f.params.settings, freeOnly: true },
    });
    assert.equal(workspace.config.concurrency.analysis, 1);
    assert.equal(workspace.config.gm2godot.checkout, "");
    await verifyHostInputs(workspace);
  } finally {
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("host research and conversion share reviewed evidence without Python or a second checkout", async () => {
  const f = fixture();
  const events: HostEvent[] = [];
  const service = new HostService((e) => events.push(e));
  try {
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: "research",
        method: "research",
        params: f.params,
      }),
    );
    await service.active?.done;
    const research = events.find((e) => e.type === "completed")?.result as {
      state: string;
      error?: unknown;
    };
    assert.equal(research.state, "review", JSON.stringify(research));
    const counted = events.filter(
      (e) =>
        e.type === "progress" &&
        typeof (e.result as { total?: number })?.total === "number",
    );
    assert.equal(
      (counted.at(-1)?.result as { completed: number; total: number })
        .completed,
      (counted.at(-1)?.result as { completed: number; total: number }).total,
    );
    const active = events
      .filter(
        (e) =>
          e.type === "progress" &&
          (e.result as { phase?: string })?.phase === "agent",
      )
      .map((e) => (e.result as { activeAgents: number }).activeAgents);
    assert.ok(active.every((n) => n >= 0 && n <= 4));
    assert.equal(active.at(-1), 0);
    const calls = events.filter(
      (e) =>
        e.type === "progress" &&
        (e.result as { phase?: string })?.phase === "agent",
    ).length;
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: "convert",
        method: "convert",
        params: { jobRoot: f.params.jobRoot },
      }),
    );
    await service.active?.done;
    const completed = events.filter((e) => e.type === "completed").at(-1)
      ?.result as {
      state: string;
      artifacts: { output: string };
      error?: unknown;
    };
    assert.equal(completed.state, "complete", JSON.stringify(completed));
    assert.equal(completed.artifacts.output, `${f.params.baselinePath}-deep`);
    assert.equal(
      events.filter(
        (e) =>
          e.type === "progress" &&
          (e.result as { phase?: string })?.phase === "agent",
      ).length,
      calls,
      "conversion must reuse research and plan",
    );
    const sequence = events
      .filter((e) => e.seq !== undefined)
      .map((e) => e.seq!);
    assert.deepEqual(
      sequence,
      [...sequence].sort((a, b) => a - b),
    );
    assert.equal(new Set(sequence).size, sequence.length);
  } finally {
    await service.close();
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("source changes fail resume without discarding earlier research", async () => {
  const f = fixture();
  try {
    const workspace = await prepareHostJob(f.params);
    writeFileSync(join(f.params.sourcePath, "demo.yyp"), "{}");
    await assert.rejects(
      () => verifyHostInputs(workspace),
      /no longer matches/,
    );
    await assert.rejects(() => prepareHostJob(f.params), /no longer matches/);
  } finally {
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("host preparation preserves client bookkeeping in the precreated job root", async () => {
  const f = fixture();
  try {
    mkdirSync(f.params.jobRoot);
    writeFileSync(join(f.params.jobRoot, "client.json"), '{"keep":true}');
    const snapshot = join(f.params.jobRoot, "host-snapshot.json");
    copyFileSync(f.params.hostSnapshotPath, snapshot);
    const workspace = await prepareHostJob({
      ...f.params,
      hostSnapshotPath: snapshot,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(workspace.root, "client.json"), "utf8")),
      { keep: true },
    );
    assert.equal(workspace.config.host?.snapshotPath, snapshot);
  } finally {
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("pause before dispatch resumes the same prepared project and cancellation is terminal", async () => {
  const f = fixture(),
    events: HostEvent[] = [];
  const service = new HostService((event) => events.push(event));
  try {
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 1,
        method: "research",
        params: f.params,
      }),
    );
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 2,
        method: "pause",
        params: { jobRoot: f.params.jobRoot },
      }),
    );
    await service.active?.done;
    assert.equal(
      (
        events.findLast((e) => e.type === "completed")?.result as {
          state: string;
        }
      ).state,
      "paused",
    );
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 3,
        method: "resume",
        params: { jobRoot: f.params.jobRoot },
      }),
    );
    await service.active?.done;
    assert.equal(
      (
        events.findLast((e) => e.type === "completed")?.result as {
          state: string;
        }
      ).state,
      "review",
    );
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 4,
        method: "cancel",
        params: { jobRoot: f.params.jobRoot },
      }),
    );
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 5,
        method: "resume",
        params: { jobRoot: f.params.jobRoot },
      }),
    );
    assert.equal(events.at(-1)?.error?.code, "HOST_CANCELLED");
  } finally {
    await service.close();
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("paused jobs can raise budgets without losing research identity", async () => {
  const f = fixture();
  try {
    await prepareHostJob(f.params);
    const record = {
      schemaVersion: 1 as const,
      jobId: "test",
      jobRoot: f.params.jobRoot,
      state: "paused",
      operation: "research" as const,
      seq: 0,
      artifacts: {},
      extensionVersion: "0.2.0",
      elapsedSeconds: 20,
    };
    updateResumeSettings(record, {
      budgets: { maxTokens: 9000000, maxCostUsd: 50, maxSeconds: 60 },
      analysisWorkers: 8,
    });
    const updated = openWorkspace(f.params.jobRoot).config;
    assert.equal(updated.agent.budgets.perRunTokens, 9000000);
    assert.equal(updated.agent.budgets.perRunCostUsd, 50);
    assert.equal(updated.host?.maxSeconds, 80);
    assert.equal(updated.concurrency.analysis, 8);
    assert.throws(
      () => updateResumeSettings(record, { runtime: "pi" }),
      /new research job/,
    );
  } finally {
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});
