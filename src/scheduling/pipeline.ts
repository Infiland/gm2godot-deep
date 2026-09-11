import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DeepError } from "../util/result.ts";
import { createLogger, type Logger } from "../util/log.ts";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "../util/json.ts";
import { sha256Bytes, sha256Text } from "../util/sha256.ts";
import { newId, nowIso } from "../util/ids.ts";
import { openDatabase, type Database } from "../storage/db.ts";
import { Repo } from "../storage/repo.ts";
import { openWorkspace, type Workspace } from "../workspaces/workspace.ts";
import { verifySnapshot } from "../workspaces/snapshot.ts";
import { promoteDirectory } from "../workspaces/staging.ts";
import type { ConfigOverrides } from "../config/load.ts";
import { resolveGodotBinary, resolvePython } from "../config/resolve.ts";
import {
  bridgeGmlApi,
  bridgeInventory,
  probeGm2Godot,
  type BridgeInventory,
  type GmlApiEntry,
  type Gm2GodotProbe,
} from "../adapters/gm2godot/bridge.ts";
import { generateBaseline, readBaselineEvidence, type BaselineEvidence } from "../adapters/gm2godot/adapter.ts";
import { diagnosticsForUnit, readConversionDiagnostics } from "../adapters/gm2godot/diagnostics.ts";
import { MANIFEST_RELATIVE_PATH } from "../adapters/gm2godot/manifest.ts";
import { SUPPORTED_GM2GODOT_VERSIONS } from "../adapters/gm2godot/versions.ts";
import { probeGodot } from "../adapters/godot/adapter.ts";
import { selectSandboxBackend } from "../sandbox/select.ts";
import {
  buildInventory,
  readBridgeInventory,
  readGmlApiEntries,
  readInventory,
  readSnapshotRecord,
  type InventoryRecord,
} from "../indexing/inventory.ts";
import { buildDependencies } from "../analysis/dependencies.ts";
import { buildGraph } from "../analysis/graph.ts";
import { applyGroups, findGroups } from "../analysis/cycles.ts";
import { hazardsFromApiUsage, type HazardRecord } from "../analysis/hazards.ts";
import type { DependencyReport } from "../analysis/edges.ts";
import { riskScore, reviewRequired } from "../planning/risk.ts";
import { seedContracts } from "../planning/contracts.ts";
import { reconcile } from "../planning/reconciler.ts";
import { planTasks, taskIdFor } from "../planning/tasks.ts";
import { AnalysisCache, analysisCacheKey } from "./cache.ts";
import { BudgetLedger, ceilingsFrom } from "./budgets.ts";
import { LeaseManager, reclaimExpired, retryStuckTasks } from "./leases.ts";
import { TaskMachine } from "./machine.ts";
import { dispatchAll, type DispatchItem } from "./scheduler.ts";
import { decideRepair } from "./retry.ts";
import { PROMPT_VERSION } from "../agents/prompts.ts";
import { ROLE_CONFIGS } from "../agents/roles.ts";
import { buildToolSpecs, type ToolBuildDeps } from "../agents/toolSpecs.ts";
import { createMockRuntime } from "../agents/mock/mockRuntime.ts";
import type { MockFacts } from "../agents/mock/script.ts";
import { createPiRuntime } from "../agents/pi/piRuntime.ts";
import type { AgentRuntime, ToolContext, Usage } from "../agents/runtime.ts";
import {
  listAnalyses,
  recordValidation,
  validateAnalysisEvidence,
  writeAnalysis,
  writeReview,
  writeValidation,
} from "../evidence/store.ts";
import type { AnalysisRecord, ConverterDiagnostic, ProducedBy, ReviewRecord } from "../evidence/schemas.ts";
import { patchDiffPath, patchJsonPath, renderUnifiedDiff } from "../integration/diff.ts";
import { integrateTask } from "../integration/integrator.ts";
import { checkBehavioral } from "../validation/behavioral.ts";
import { checkCoverage } from "../validation/coverage.ts";
import { runGodotHeadless } from "../validation/godotRun.ts";
import { checkPresentation } from "../validation/presentation.ts";
import { checkStructural } from "../validation/structural.ts";
import type { ValidationResult } from "../validation/levels.ts";
import { repoRoot } from "../util/package.ts";
import type { TaskRecord, UnitStrategy } from "../storage/types.ts";
import type { AnalysisUnit } from "../indexing/units.ts";

export type Phase = "inventory" | "baseline" | "analyze" | "plan" | "implement" | "validate" | "report";

export const PHASE_ORDER: readonly Phase[] = ["inventory", "baseline", "analyze", "plan", "implement", "validate", "report"];

export interface PipelineOptions {
  readonly workspace: Workspace;
  readonly repo: Repo;
  readonly logger: Logger;
  readonly through: Phase;
  readonly execute: boolean;
  readonly maxWorkers: number | null;
  readonly taskFilter: readonly string[];
  readonly allowStaleBaseline: boolean;
  readonly signal: AbortSignal;
}

export interface PipelineOutcome {
  readonly reached: Phase;
  readonly blocked: readonly string[];
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
}

export interface DoctorReport {
  readonly gm2godot: {
    readonly version: string | null;
    readonly commit: string | null;
    readonly checkout: string;
    readonly python: string;
    readonly pythonVersion: string | null;
    readonly matchesExpected: boolean;
    readonly expected: readonly string[];
    readonly error: string | null;
  };
  readonly godot: { readonly path: string | null; readonly version: string | null; readonly matchesExpected: boolean; readonly reason: string };
  readonly sandbox: { readonly backend: string; readonly available: boolean; readonly detail: string };
  readonly bridge: { readonly reachable: boolean; readonly error: string | null };
  readonly gmlApiEntryCount: number | null;
}

function phaseRank(phase: Phase): number {
  return PHASE_ORDER.indexOf(phase);
}

export function openWorkspaceRepo(root: string, overrides: ConfigOverrides = {}): { workspace: Workspace; repo: Repo; db: Database } {
  const workspace = openWorkspace(root, overrides);
  const db = openDatabase(workspace.paths.database);
  return { workspace, repo: new Repo(db), db };
}

function resolveToolchain(workspace: Workspace): { python: string; godotBinary: string | null } {
  return {
    python: resolvePython(workspace.config).path,
    godotBinary: resolveGodotBinary(workspace.config)?.path ?? null,
  };
}

/** Probe every external tool the pipeline depends on. A missing tool is reported, never assumed present. */
export async function runDoctor(input: { workspace: Workspace; logger: Logger }): Promise<DoctorReport> {
  const config = input.workspace.config;
  const python = resolvePython(config).path;
  let gm2godotError: string | null = null;
  let probe: Gm2GodotProbe | null = null;
  let gmlApiEntryCount: number | null = null;
  let bridgeReachable = false;
  try {
    probe = await probeGm2Godot({ checkout: config.gm2godot.checkout, python }, config.gm2godot.expectedVersions);
    gmlApiEntryCount = (await bridgeGmlApi({ checkout: config.gm2godot.checkout, python })).length;
    bridgeReachable = true;
  } catch (error) {
    gm2godotError = error instanceof DeepError ? `${error.code}: ${error.message}` : String(error);
  }
  const expected = [...config.gm2godot.expectedVersions];
  const version = probe?.gm2godotVersion ?? null;

  const godotProbe = await probeGodot(config.godot.binary ?? resolveGodotBinary(config)?.path ?? null, {
    expectedVersion: config.godot.expectedVersion,
    expectedVersionPrefix: config.godot.expectedVersionPrefix,
  });

  let sandboxBackend = "none";
  let sandboxAvailable = false;
  let sandboxDetail = "isolation-requiring operations will fail closed";
  try {
    const backend = await selectSandboxBackend(config);
    sandboxBackend = backend.id;
    sandboxAvailable = true;
    sandboxDetail = `${backend.id} (available)`;
  } catch (error) {
    sandboxDetail = error instanceof DeepError ? error.message : String(error);
  }

  return {
    gm2godot: {
      version,
      commit: probe?.commit ?? null,
      checkout: config.gm2godot.checkout,
      python,
      pythonVersion: probe?.pythonVersion ?? null,
      matchesExpected: version !== null && expected.includes(version),
      expected,
      error: gm2godotError,
    },
    godot: {
      path: godotProbe.path,
      version: godotProbe.version,
      matchesExpected: godotProbe.matchesExpected,
      reason: godotProbe.reason,
    },
    sandbox: { backend: sandboxBackend, available: sandboxAvailable, detail: sandboxDetail },
    bridge: { reachable: bridgeReachable, error: gm2godotError },
    gmlApiEntryCount,
  };
}

// ------------------------------------------------------------------ runtime

interface UnitRuntimeContext {
  readonly toolDeps: ToolBuildDeps;
  readonly facts: MockFacts;
}

interface RuntimeBundle {
  readonly runtime: AgentRuntime;
  readonly credentials: Readonly<Record<string, string>>;
}

function producedByFor(options: PipelineOptions, usage: Usage): ProducedBy {
  return {
    runtime: options.workspace.config.agent.runtime,
    simulated: options.workspace.config.agent.runtime === "mock",
    ...(options.workspace.config.agent.provider === null ? {} : { provider: options.workspace.config.agent.provider }),
    ...(options.workspace.config.agent.model === null ? {} : { model: options.workspace.config.agent.model }),
    promptVersion: PROMPT_VERSION,
    schemaVersion: 1,
    usage,
  };
}

const MOCK_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, reported: false };

function runtimeFor(
  options: PipelineOptions,
  contexts: Map<string, UnitRuntimeContext>,
): RuntimeBundle {
  const config = options.workspace.config;
  const resolveContext = (request: { taskId: string }): UnitRuntimeContext => {
    const context = contexts.get(request.taskId);
    if (context === undefined) {
      throw new DeepError("GM2DEEP-RUNTIME-CONTEXT-MISSING", `no unit context registered for ${request.taskId}`);
    }
    return context;
  };
  if (config.agent.runtime === "mock") {
    return {
      runtime: createMockRuntime({
        transcriptsDir: options.workspace.paths.transcripts,
        factsFor: (request) => resolveContext(request),
        logger: options.logger,
      }),
      credentials: {},
    };
  }
  return {
    runtime: createPiRuntime({
      config,
      credentials: {},
      transcriptsDir: options.workspace.paths.transcripts,
      logger: options.logger,
    }),
    credentials: {},
  };
}

// ---------------------------------------------------------------- pipeline

export async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
  const blocked: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const run = options.repo.createRun(newId("run"), options.through, options.execute, { cwd: process.cwd() });
  const machine = new TaskMachine(options.repo);
  const leases = new LeaseManager(options.repo, `${process.pid}-${run.id}`);
  const budget = new BudgetLedger(options.repo, run.id, ceilingsFrom(options.workspace.config));
  const contexts = new Map<string, UnitRuntimeContext>();

  const state = {
    inventory: null as InventoryRecord | null,
    bridge: null as BridgeInventory | null,
    gmlApi: [] as GmlApiEntry[],
    probe: null as Gm2GodotProbe | null,
    dependencies: null as DependencyReport | null,
    units: [] as AnalysisUnit[],
    hazards: [] as HazardRecord[],
    python: "",
    godotBinary: null as string | null,
  };
  state.python = resolvePython(options.workspace.config).path;
  state.godotBinary = resolveGodotBinary(options.workspace.config)?.path ?? null;

  try {
    if (phaseRank(options.through) >= phaseRank("inventory")) {
      options.repo.updateRunPhase(run.id, "inventory");
      await phaseInventory(options, state);
    }
    if (phaseRank(options.through) >= phaseRank("baseline")) {
      options.repo.updateRunPhase(run.id, "baseline");
      await phaseBaseline(options, state);
    }
    if (phaseRank(options.through) >= phaseRank("analyze")) {
      options.repo.updateRunPhase(run.id, "analyze");
      await phaseAnalyze(options, state, contexts, blocked, failed, skipped);
    }
    if (phaseRank(options.through) >= phaseRank("plan")) {
      options.repo.updateRunPhase(run.id, "plan");
      await phasePlan(options, state, contexts, blocked);
    }
    if (options.execute && phaseRank(options.through) >= phaseRank("implement")) {
      options.repo.updateRunPhase(run.id, "implement");
      await phaseImplement(options, state, contexts, machine, leases, budget, blocked, failed, skipped);
    }
    if (options.execute && phaseRank(options.through) >= phaseRank("validate")) {
      options.repo.updateRunPhase(run.id, "validate");
      await phaseValidate(options, state, blocked, failed, skipped);
    }
    if (phaseRank(options.through) >= phaseRank("report")) {
      options.repo.updateRunPhase(run.id, "report");
      const { writeReport } = await import("../evidence/report.ts");
      await writeReport({ workspace: options.workspace, repo: options.repo, logger: options.logger });
    }
    options.repo.finishRun(run.id, blocked.length > 0 || failed.length > 0 ? "incomplete" : "completed", {
      blocked,
      failed,
      skipped,
    });
    return { reached: options.through, blocked, failed, skipped };
  } finally {
    leases.releaseAll();
  }
}

interface PipelineState {
  inventory: InventoryRecord | null;
  bridge: BridgeInventory | null;
  gmlApi: GmlApiEntry[];
  probe: Gm2GodotProbe | null;
  dependencies: DependencyReport | null;
  units: AnalysisUnit[];
  hazards: HazardRecord[];
  python: string;
  godotBinary: string | null;
}

async function phaseInventory(options: PipelineOptions, state: PipelineState): Promise<void> {
  const { workspace } = options;
  const snapshot = readSnapshotRecord(workspace.paths.evidenceInventory);
  await verifySnapshot(workspace.paths.source, snapshot);
  const bridgeOptions = { checkout: workspace.config.gm2godot.checkout, python: state.python };
  state.probe = await probeGm2Godot(bridgeOptions, workspace.config.gm2godot.expectedVersions);
  state.bridge = await bridgeInventory(bridgeOptions, workspace.paths.source);
  state.gmlApi = await bridgeGmlApi(bridgeOptions);
  const baselineDir = existsSync(join(workspace.paths.baseline, MANIFEST_RELATIVE_PATH)) ? workspace.paths.baseline : null;
  state.inventory = await buildInventory({
    snapshot,
    snapshotDir: workspace.paths.source,
    baselineDir,
    bridge: state.bridge,
    probe: state.probe,
    gmlApiEntries: state.gmlApi,
    evidenceInventoryDir: workspace.paths.evidenceInventory,
  });
  options.logger.info(
    `inventory: ${state.inventory.counts.total} file(s), ${state.inventory.counts.unitsTotal} unit(s), ${state.inventory.counts.unitsRequiringAnalysis} requiring analysis`,
  );
}

async function phaseBaseline(options: PipelineOptions, state: PipelineState): Promise<void> {
  const { workspace } = options;
  const existingManifest = join(workspace.paths.baseline, MANIFEST_RELATIVE_PATH);
  if (existsSync(existingManifest)) {
    const provenance = readBaselineProvenance(workspace.paths.baseline);
    const evidence = readBaselineEvidence(workspace.paths.evidenceInventory);
    if (provenance.fresh && evidence.baselineId === provenance.baselineId) {
      options.logger.info(`baseline: reusing recorded generation ${provenance.baselineId}`);
      await refreshInventoryWithBaseline(options, state, workspace.paths.baseline);
      return;
    }
    options.logger.warn(`baseline: existing generation is not fresh (${provenance.reasons.join("; ")}); regenerating`);
  }

  const result = await generateBaseline({
    sourceDir: workspace.paths.source,
    baselineDir: workspace.paths.baseline,
    stagingRoot: workspace.paths.staging,
    evidenceInventoryDir: workspace.paths.evidenceInventory,
    config: workspace.config,
    python: state.python,
    toolchain: {
      gm2godotVersion: state.probe?.gm2godotVersion ?? null,
      gm2godotCommit: state.probe?.commit ?? null,
      pythonVersion: state.probe?.pythonVersion ?? null,
    },
    allowStaleBaseline: options.allowStaleBaseline,
    onAttempt: (evidence) =>
      options.repo.recordBaselineAttempt({
        id: newId("attempt"),
        exitCode: evidence.exitCode ?? -1,
        state: evidence.state,
        fresh: evidence.outcome === "success" || evidence.outcome === "partial",
        detail: evidence,
      }),
  });
  options.logger.info(`baseline: ${result.interpretation.outcome} (exit ${String(result.exitCode)}) -> ${result.godotProjectDir}`);
  await refreshInventoryWithBaseline(options, state, workspace.paths.baseline);
}

async function refreshInventoryWithBaseline(options: PipelineOptions, state: PipelineState, baselineDir: string): Promise<void> {
  const { workspace } = options;
  if (state.bridge === null || state.probe === null) return;
  const snapshot = readSnapshotRecord(workspace.paths.evidenceInventory);
  state.inventory = await buildInventory({
    snapshot,
    snapshotDir: workspace.paths.source,
    baselineDir,
    bridge: state.bridge,
    probe: state.probe,
    gmlApiEntries: state.gmlApi,
    evidenceInventoryDir: workspace.paths.evidenceInventory,
  });
}

function toolContextFor(
  options: PipelineOptions,
  task: TaskRecord,
  signal: AbortSignal,
  recordPolicyDenial: ToolContext["recordPolicyDenial"],
): ToolContext {
  const { workspace } = options;
  return {
    role: task.role,
    taskId: task.id,
    workspaceRoots: {
      source: workspace.paths.source,
      baseline: workspace.paths.baseline,
      port: workspace.paths.port,
      task: workspace.paths.tasks,
      evidence: workspace.paths.evidence,
    },
    allowlist: task.allowlist,
    logger: options.logger,
    recordPolicyDenial,
    signal,
    attempt: Math.max(1, task.attempt),
  };
}

export { phaseAnalyze, phasePlan, phaseImplement, phaseValidate, runtimeFor, toolContextFor, producedByFor, MOCK_USAGE };
