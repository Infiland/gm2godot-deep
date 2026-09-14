import { readMonitoring } from "../../src/host/monitoring.ts";
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
    const researched = events.filter(
      (event) =>
        event.type === "progress" &&
        (event.result as { phase?: string; state?: string })?.phase ===
          "research" &&
        (event.result as { state?: string }).state === "completed",
    );
    assert.ok(researched.length > 0);
    for (const event of researched) {
      const row = event.result as { summary: string; artifact: string };
      assert.ok(row.summary && row.summary !== "Awaiting research");
      assert.ok(JSON.parse(readFileSync(row.artifact, "utf8")).purpose.text);
    }
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
    const originalIdentity = updated.host?.researchModelIdentity;
    updateResumeSettings(record, { provider: "example", model: "next-model" });
    const switched = openWorkspace(f.params.jobRoot).config;
    assert.equal(switched.agent.model, "next-model");
    assert.equal(switched.host?.researchModelIdentity, originalIdentity);
  } finally {
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("live configure is additive, persists a bounded free worker cap and cannot change a model", async () => {
  const f = fixture(),
    events: HostEvent[] = [];
  const service = new HostService((event) => events.push(event));
  try {
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 1,
        method: "research",
        params: {
          ...f.params,
          settings: { ...f.params.settings, freeOnly: true },
        },
      }),
    );
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 2,
        method: "configure",
        params: { jobRoot: f.params.jobRoot, analysisWorkers: 32 },
      }),
    );
    assert.equal(
      (events.at(-1)?.result as { analysisWorkers: number }).analysisWorkers,
      1,
    );
    assert.equal(service.active?.analysisWorkers, 1);
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 3,
        method: "configure",
        params: {
          jobRoot: f.params.jobRoot,
          analysisWorkers: 4,
          freeProviderConcurrency: 2,
        },
      }),
    );
    assert.equal(service.active?.analysisWorkers, 2);
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: 4,
        method: "configure",
        params: {
          jobRoot: f.params.jobRoot,
          analysisWorkers: 3,
          model: "paid",
        },
      }),
    );
    assert.equal(events.at(-1)?.type, "error");
    await service.close();
    assert.equal(
      openWorkspace(f.params.jobRoot).config.concurrency.analysis,
      2,
    );
  } finally {
    await service.close();
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("free-only resume cannot disable its policy or select a paid role provider", async () => {
  const f = fixture();
  try {
    await prepareHostJob({
      ...f.params,
      settings: {
        ...f.params.settings,
        runtime: "opencode",
        provider: "opencode",
        model: "auto-free",
        freeOnly: true,
      },
    });
    const record = {
      schemaVersion: 1 as const,
      jobId: "test",
      jobRoot: f.params.jobRoot,
      state: "paused",
      operation: "research" as const,
      seq: 0,
      artifacts: {},
      extensionVersion: "0.2.0",
    };
    assert.throws(
      () => updateResumeSettings(record, { freeOnly: false }),
      /cannot switch to paid/,
    );
    assert.throws(
      () =>
        updateResumeSettings(record, {
          roleOverrides: { reviewer: { provider: "paid" } },
        }),
      /every role/,
    );
    assert.equal(openWorkspace(f.params.jobRoot).config.agent.freeOnly, true);
  } finally {
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("paused model selection keeps completed research and exposes durable task and agent snapshots", async () => {
  const f = fixture(),
    events: HostEvent[] = [];
  let pauseRequested = false;
  const service = new HostService((event) => {
    events.push(event);
    const progress = event.result as
      | { phase?: string; state?: string }
      | undefined;
    if (
      !pauseRequested &&
      event.type === "progress" &&
      progress?.phase === "research" &&
      progress.state === "completed"
    ) {
      pauseRequested = true;
      void service.handle(
        RequestSchema.parse({
          protocolVersion: 1,
          id: "pause",
          method: "pause",
          params: { jobRoot: f.params.jobRoot },
        }),
      );
    }
  });
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
    assert.equal(pauseRequested, true);
    const runningAnalysts = (): string[] =>
      events
        .filter((event) => {
          const progress = event.result as
            | {
                phase?: string;
                state?: string;
                role?: string;
                summary?: string;
              }
            | undefined;
          return (
            event.type === "progress" &&
            progress?.phase === "agent" &&
            progress.role === "analyst" &&
            progress.state === "running" &&
            !progress.summary
          );
        })
        .map((event) => (event.result as { taskId: string }).taskId);
    const before = runningAnalysts();
    assert.ok(before.length > 0);
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: "resume",
        method: "resume",
        params: { jobRoot: f.params.jobRoot, settings: { model: "mock-next" } },
      }),
    );
    await service.active?.done;
    assert.equal(
      (
        events.findLast((event) => event.type === "completed")?.result as {
          state: string;
        }
      ).state,
      "review",
    );
    assert.deepEqual(
      runningAnalysts(),
      before,
      "completed unit research must not repeat when the chosen model changes",
    );
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: "status",
        method: "status",
        params: { jobRoot: f.params.jobRoot },
      }),
    );
    const monitoring = (
      events.at(-1)?.result as {
        monitoring: {
          tasks: { state: string }[];
          agents: { agentId: string; state: string }[];
        };
      }
    ).monitoring;
    assert.ok(monitoring.tasks.some((task) => task.state === "completed"));
    assert.ok(monitoring.agents.length > 0);
    assert.ok(
      monitoring.agents.every(
        (agent) => agent.agentId && agent.state !== "running",
      ),
    );
    assert.ok(events.some((event) => event.type === "settings_changed"));
  } finally {
    await service.close();
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unchanged native settings resume even when discovery cannot enumerate its model", async () => {
  const f = fixture(),
    events: HostEvent[] = [];
  const service = new HostService((event) => events.push(event));
  try {
    const settings = {
      ...f.params.settings,
      runtime: "claude" as const,
      model: "sonnet",
      executable: join(f.root, "missing-claude"),
      provider: null,
    };
    await prepareHostJob({ ...f.params, settings });
    writeFileSync(
      join(f.params.jobRoot, "host-job.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobId: "native",
        jobRoot: f.params.jobRoot,
        state: "paused",
        operation: "research",
        seq: 0,
        artifacts: {},
        extensionVersion: "0.2.0",
      }),
    );
    await service.handle(
      RequestSchema.parse({
        protocolVersion: 1,
        id: "resume",
        method: "resume",
        params: { jobRoot: f.params.jobRoot, settings },
      }),
    );
    assert.equal(
      events.find((event) => event.id === "resume")?.type,
      "result",
      "unchanged model identity must not be rejected by empty discovery",
    );
    await service.close();
  } finally {
    await service.close();
    thawTree(f.root);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("status replay marks every interrupted active state paused and preserves settled outcomes", () => {
  const root = mkdtempSync(join(tmpdir(), "deep-monitoring-"));
  try {
    const states = [
      "running",
      "validating",
      "implementing",
      "retrying",
      "completed",
      "failed",
    ];
    writeFileSync(
      join(root, "host-events.jsonl"),
      states
        .flatMap((state) => [
          {
            type: "progress",
            result: { phase: "implementation", taskId: state, state },
          },
          {
            type: "progress",
            result: { phase: "agent", agentId: state, state },
          },
        ])
        .map((event) => JSON.stringify(event))
        .join("\n") + '\n{"interrupted":',
    );
    const replay = readMonitoring(root, false);
    for (const rows of [replay.tasks, replay.agents])
      assert.deepEqual(
        rows.map((row) => row.state),
        ["paused", "paused", "paused", "paused", "completed", "failed"],
      );
    assert.equal(readMonitoring(root, true).tasks[1]?.state, "validating");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
