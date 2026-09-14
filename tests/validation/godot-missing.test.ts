import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisCache } from "../../src/scheduling/cache.ts";
import { BudgetLedger, ceilingsFrom } from "../../src/scheduling/budgets.ts";
import { LeaseManager } from "../../src/scheduling/leases.ts";
import { TaskMachine } from "../../src/scheduling/machine.ts";
import {
  phaseValidate,
  type PipelineOptions,
  type PipelineRun,
  type PipelineState,
} from "../../src/scheduling/pipeline.ts";
import { writeReport } from "../../src/evidence/report.ts";
import { createLogger } from "../../src/util/log.ts";
import { newId } from "../../src/util/ids.ts";
import type { AgentRuntime } from "../../src/agents/runtime.ts";
import {
  createTestWorkspace,
  minimalInventory,
  readJson,
  writeFileEnsured,
  type TestWorkspace,
} from "../helpers/harness.ts";

const NO_BINARY_REASON = "godot binary not configured or not found";

const unusedRuntime: AgentRuntime = {
  id: "mock",
  simulated: true,
  run: () =>
    Promise.reject(new Error("the runtime must not be invoked by validation")),
};

function runWithoutGodot(ws: TestWorkspace): PipelineRun {
  const logger = createLogger({ stderr: () => {} });
  const options: PipelineOptions = {
    workspace: ws.workspace,
    repo: ws.repo,
    logger,
    through: "validate",
    execute: true,
    maxWorkers: null,
    taskFilter: [],
    allowStaleBaseline: false,
    signal: new AbortController().signal,
  };
  const state: PipelineState = {
    inventory: minimalInventory(),
    bridge: null,
    gmlApi: [],
    probe: null,
    dependencies: null,
    units: [],
    groups: [],
    hazards: [],
    analyses: new Map(),
    reviews: new Map(),
    risks: new Map(),
    seeds: [],
    contracts: [],
    plan: null,
    drafts: new Map(),
    baselineId: null,
    python: "/usr/bin/python3",
    godotBinary: null,
    godotVersion: null,
  };
  return {
    options,
    repo: ws.repo,
    machine: new TaskMachine(ws.repo),
    leases: new LeaseManager(ws.repo, "godot-missing-test"),
    budget: new BudgetLedger(
      ws.repo,
      newId("run"),
      ceilingsFrom(ws.workspace.config),
    ),
    cache: new AnalysisCache(ws.repo),
    contexts: new Map(),
    state,
    blocked: [],
    failed: [],
    skipped: [],
    portMutex: (body) => Promise.resolve(body()),
    planVersion: 1,
    runtime: unusedRuntime,
    credentials: {},
  };
}

test("without a Godot binary, levels B and C are skipped with a reason and never report passed", async () => {
  const ws = createTestWorkspace("godot-missing");
  try {
    // `ensurePort` needs a seeded port: only project.godot is required for the engine-backed checks to
    // have a project to point at.
    writeFileEnsured(
      join(ws.workspace.paths.port, "project.godot"),
      "; Engine configuration file.\n",
    );

    const run = runWithoutGodot(ws);
    await phaseValidate(run);

    const rows = ws.repo.listValidation();
    const boot = rows.find((row) => row.checkId === "runtime-boot");
    assert.ok(boot !== undefined, "level C runtime-boot must be recorded");
    assert.equal(boot.level, "C");
    assert.equal(boot.state, "skipped");
    assert.equal(boot.reason, NO_BINARY_REASON);
    assert.equal(boot.command, null);
    assert.equal(boot.engineVersion, null);
    assert.equal(boot.exitStatus, null);

    const gm2godotValidate = rows.find(
      (row) => row.checkId === "structural-gm2godot",
    );
    assert.ok(
      gm2godotValidate !== undefined,
      "the converter-backed level B half must be recorded",
    );
    assert.equal(gm2godotValidate.level, "B");
    assert.equal(gm2godotValidate.state, "skipped");
    assert.match(
      gm2godotValidate.reason ?? "",
      /godot binary not configured or not found|checkout-based validation is unavailable/,
    );

    // The static half of level B may pass (it is in-process), but no level B/C check may claim an engine
    // executed: a passed engine check carries a command, an engine build and an exit status.
    for (const row of rows.filter(
      (entry) => entry.level === "B" || entry.level === "C",
    )) {
      if (row.state !== "passed") continue;
      assert.equal(
        row.engineVersion,
        null,
        `${row.checkId} claims an engine build without a binary`,
      );
      assert.match(
        row.command ?? "",
        /^in-process: /,
        "only an in-process check may pass without a binary",
      );
    }
    assert.equal(
      rows.some((row) => row.level === "C" && row.state === "passed"),
      false,
      "level C must not pass without an engine",
    );

    await writeReport({
      workspace: ws.workspace,
      repo: ws.repo,
      logger: createLogger({ stderr: () => {} }),
    });
    const report = readJson<{
      validation: {
        checks: {
          level: string;
          checkId: string;
          state: string;
          engineVersion: string | null;
          reason: string | null;
        }[];
        byLevel: Record<string, Record<string, number>>;
      };
    }>(join(ws.workspace.paths.evidenceReports, "report.json"));

    const reportBoot = report.validation.checks.find(
      (row) => row.checkId === "runtime-boot",
    );
    assert.equal(reportBoot?.state, "skipped");
    assert.equal(reportBoot?.reason, NO_BINARY_REASON);
    assert.equal(report.validation.byLevel["C"]?.["passed"] ?? 0, 0);
    for (const row of report.validation.checks.filter(
      (entry) => entry.level === "B" || entry.level === "C",
    )) {
      if (row.state === "passed") assert.equal(row.engineVersion, null);
    }
  } finally {
    ws.cleanup();
  }
});
