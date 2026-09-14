import { ModelBudgetGate } from "./modelBudgetGate.ts";
import { provenanceForResult } from "../evidence/provenance.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DeepError } from "../util/result.ts";
import type { Logger } from "../util/log.ts";
import { newId } from "../util/ids.ts";
import { openDatabase, type Database } from "../storage/db.ts";
import { Repo } from "../storage/repo.ts";
import {
  openWorkspace,
  removeTree,
  type Workspace,
} from "../workspaces/workspace.ts";
import { copyTree } from "../workspaces/staging.ts";
import { thawTree, verifySnapshot } from "../workspaces/snapshot.ts";
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
import {
  generateBaseline,
  readBaselineEvidence,
  type BaselineEvidence,
} from "../adapters/gm2godot/adapter.ts";
import {
  MANIFEST_RELATIVE_PATH,
  readBaselineProvenance,
} from "../adapters/gm2godot/manifest.ts";
import { probeGodot } from "../adapters/godot/adapter.ts";
import { selectSandboxBackend } from "../sandbox/select.ts";
import {
  buildInventory,
  readSnapshotRecord,
  type InventoryRecord,
} from "../indexing/inventory.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import type {
  AnalysisRecord,
  ContractRecord,
  PatchRecordPayload,
  PlanRecord,
  ProducedBy,
  ReviewRecord,
} from "../evidence/schemas.ts";
import { AnalysisCache } from "./cache.ts";
import { BudgetLedger, ceilingsFrom } from "./budgets.ts";
import { LeaseManager } from "./leases.ts";
import { TaskMachine } from "./machine.ts";
import { PROMPT_VERSION } from "../agents/prompts.ts";
import { createMockRuntime } from "../agents/mock/mockRuntime.ts";
import type { MockFacts, MockPlanInput } from "../agents/mock/script.ts";
import { createRuntime } from "../agents/factory.ts";
import { readJsonFile } from "../util/json.ts";
import { HostSnapshotSchema } from "../host/protocol.ts";
import { SnapshotRecordSchema } from "../workspaces/snapshot.ts";
import type {
  AgentRunResult,
  AgentRuntime,
  ToolContext,
  Usage,
} from "../agents/runtime.ts";
import type { ToolBuildDeps } from "../agents/toolSpecs.ts";
import type {
  RiskAssessment,
  TaskRecord,
  UnitStrategy,
} from "../storage/types.ts";
import type { DependencyReport } from "../analysis/edges.ts";
import type { HazardRecord } from "../analysis/hazards.ts";
import type { UnitGroup } from "../analysis/cycles.ts";
import type { ImplementationTaskDraft } from "../planning/tasks.ts";
import {
  phaseAnalyze,
  phaseImplement,
  phasePlan,
  phaseReport,
  phaseValidate,
} from "./phases.ts";

export type Phase =
  | "inventory"
  | "baseline"
  | "analyze"
  | "plan"
  | "implement"
  | "validate"
  | "report";

export const PHASE_ORDER: readonly Phase[] = [
  "inventory",
  "baseline",
  "analyze",
  "plan",
  "implement",
  "validate",
  "report",
];

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
  readonly reusePlan?: boolean;
  readonly onProgress?: (event: Record<string, unknown>) => void;
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
  readonly godot: {
    readonly path: string | null;
    readonly version: string | null;
    readonly matchesExpected: boolean;
    readonly reason: string;
  };
  readonly sandbox: {
    readonly backend: string;
    readonly available: boolean;
    readonly detail: string;
  };
  readonly bridge: {
    readonly reachable: boolean;
    readonly error: string | null;
  };
  readonly gmlApiEntryCount: number | null;
}

function phaseRank(phase: Phase): number {
  return PHASE_ORDER.indexOf(phase);
}

export function openWorkspaceRepo(
  root: string,
  overrides: ConfigOverrides = {},
): { workspace: Workspace; repo: Repo; db: Database } {
  const workspace = openWorkspace(root, overrides);
  const db = openDatabase(workspace.paths.database);
  return { workspace, repo: new Repo(db), db };
}

/** Probe every external tool the pipeline depends on. A missing tool is reported, never assumed present. */
export async function runDoctor(input: {
  workspace: Workspace;
  logger: Logger;
}): Promise<DoctorReport> {
  const config = input.workspace.config;
  const python = resolvePython(config).path;
  let gm2godotError: string | null = null;
  let probe: Gm2GodotProbe | null = null;
  let gmlApiEntryCount: number | null = null;
  let bridgeReachable = false;
  try {
    probe = await probeGm2Godot(
      { checkout: config.gm2godot.checkout, python },
      config.gm2godot.expectedVersions,
    );
    gmlApiEntryCount = (
      await bridgeGmlApi({ checkout: config.gm2godot.checkout, python })
    ).length;
    bridgeReachable = true;
  } catch (error) {
    gm2godotError =
      error instanceof DeepError
        ? `${error.code}: ${error.message}`
        : String(error);
  }
  const expected = [...config.gm2godot.expectedVersions];
  const version = probe?.gm2godotVersion ?? null;

  const godotProbe = await probeGodot(
    config.godot.binary ?? resolveGodotBinary(config)?.path ?? null,
    {
      expectedVersion: config.godot.expectedVersion,
      expectedVersionPrefix: config.godot.expectedVersionPrefix,
    },
  );

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
    sandbox: {
      backend: sandboxBackend,
      available: sandboxAvailable,
      detail: sandboxDetail,
    },
    bridge: { reachable: bridgeReachable, error: gm2godotError },
    gmlApiEntryCount,
  };
}

// ------------------------------------------------------------------ runtime

/** Everything the deterministic runtime needs to answer one request, keyed by the request's task id. */
export interface UnitRuntimeContext {
  readonly toolDeps: ToolBuildDeps;
  readonly facts: MockFacts;
}

interface RuntimeBundle {
  readonly runtime: AgentRuntime;
  readonly credentials: Readonly<Record<string, string>>;
}

export function producedByFor(
  options: PipelineOptions,
  usage: Usage,
  provenance?: AgentRunResult["provenance"],
): ProducedBy {
  const config = options.workspace.config;
  const fallback: ProducedBy = {
    runtime: config.agent.runtime,
    simulated: config.agent.runtime === "mock",
    ...(!config.agent.provider ? {} : { provider: config.agent.provider }),
    ...(!config.agent.model ? {} : { model: config.agent.model }),
    promptVersion: PROMPT_VERSION,
    schemaVersion: 1,
    usage,
  };
  return provenanceForResult(fallback, {
    usage,
    ...(provenance ? { provenance } : {}),
  });
}

export const MOCK_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  reported: false,
};

/** The mock reconciler is told which strategies to record from the analysed state, not from a model. */
function mockPlanInputFor(run: PipelineRun): MockPlanInput {
  const strategies: Record<string, UnitStrategy> = {};
  for (const unit of run.state.units) {
    if (!unit.analysisRequired) continue;
    strategies[unit.id] =
      run.state.analyses.get(unit.id)?.strategy ?? "retain_generated";
  }
  return {
    unitIds: Object.keys(strategies).sort(),
    strategies,
    contracts: run.state.seeds.map((seed) => ({
      concern: seed.concern,
      version: seed.version,
      rules: seed.rules,
    })),
  };
}

function resolveContext(run: PipelineRun, taskId: string): UnitRuntimeContext {
  const exact = run.contexts.get(taskId);
  if (exact !== undefined) return exact;
  const hash = taskId.indexOf("#");
  const base = hash === -1 ? null : run.contexts.get(taskId.slice(0, hash));
  if (base !== null && base !== undefined) return base;
  throw new DeepError(
    "GM2DEEP-RUNTIME-CONTEXT-MISSING",
    `no unit context registered for ${taskId}`,
  );
}

export function runtimeFor(run: PipelineRun): RuntimeBundle {
  const config = run.options.workspace.config;
  if (config.agent.runtime === "mock") {
    return {
      runtime: createMockRuntime({
        transcriptsDir: run.options.workspace.paths.transcripts,
        factsFor: (request) => resolveContext(run, request.taskId),
        planInputFor: () => mockPlanInputFor(run),
        logger: run.options.logger,
      }),
      credentials: {},
    };
  }
  return {
    runtime: createRuntime({
      config,
      credentials: {},
      transcriptsDir: run.options.workspace.paths.transcripts,
      logger: run.options.logger,
    }),
    credentials: {},
  };
}

// ---------------------------------------------------------------- pipeline run

/** The mutable state every phase reads and refines. One object, threaded through every phase. */
export interface PipelineState {
  inventory: InventoryRecord | null;
  bridge: BridgeInventory | null;
  gmlApi: GmlApiEntry[];
  probe: Gm2GodotProbe | null;
  dependencies: DependencyReport | null;
  units: AnalysisUnit[];
  groups: readonly UnitGroup[];
  hazards: readonly HazardRecord[];
  analyses: Map<string, AnalysisRecord>;
  reviews: Map<string, ReviewRecord>;
  risks: Map<string, RiskAssessment>;
  seeds: readonly ContractRecord[];
  contracts: readonly ContractRecord[];
  plan: PlanRecord | null;
  drafts: Map<string, ImplementationTaskDraft>;
  baselineId: string | null;
  python: string;
  godotBinary: string | null;
  godotVersion: string | null;
}

/** One run: the fixed options plus every mutable collaborator the phases share. */
export interface PipelineRun {
  readonly options: PipelineOptions;
  readonly repo: Repo;
  readonly machine: TaskMachine;
  readonly leases: LeaseManager;
  readonly budget: BudgetLedger;
  readonly cache: AnalysisCache;
  readonly contexts: Map<string, UnitRuntimeContext>;
  readonly state: PipelineState;
  readonly blocked: string[];
  readonly failed: string[];
  readonly skipped: string[];
  readonly portMutex: <T>(body: () => Promise<T> | T) => Promise<T>;
  readonly planVersion: number;
  runtime: AgentRuntime;
  credentials: Readonly<Record<string, string>>;
}

function createMutex(): <T>(body: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(body: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(() => body());
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function readBaselineId(workspace: Workspace): string | null {
  try {
    return readBaselineEvidence(workspace.paths.evidenceInventory).baselineId;
  } catch {
    return null;
  }
}

export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineOutcome> {
  const blocked: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const run = options.repo.createRun(
    newId("run"),
    options.through,
    options.execute,
    { cwd: process.cwd() },
  );
  const state: PipelineState = {
    inventory: null,
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
    baselineId: readBaselineId(options.workspace),
    python:
      options.workspace.config.host === null
        ? resolvePython(options.workspace.config).path
        : "",
    godotBinary: resolveGodotBinary(options.workspace.config)?.path ?? null,
    godotVersion: null,
  };
  const pipeline: PipelineRun = {
    options,
    repo: options.repo,
    machine: new TaskMachine(options.repo),
    leases: new LeaseManager(options.repo, `${String(process.pid)}-${run.id}`),
    budget: new BudgetLedger(
      options.repo,
      run.id,
      ceilingsFrom(options.workspace.config),
      options.workspace.config.host !== null,
    ),
    cache: new AnalysisCache(options.repo),
    contexts: new Map(),
    state,
    blocked,
    failed,
    skipped,
    portMutex: createMutex(),
    planVersion: 1,
    runtime: null as unknown as AgentRuntime,
    credentials: {},
  };
  const bundle = runtimeFor(pipeline);
  const budgetGate = new ModelBudgetGate(
    pipeline.budget,
    bundle.runtime.simulated || options.workspace.config.agent.freeOnly,
  );
  const activeAgents = new Set<string>();
  pipeline.runtime = {
    ...bundle.runtime,
    run: async (request) => {
      options.signal.throwIfAborted();
      pipeline.budget.assertNotExceeded(request.taskId);
      const identity = `${request.taskId}:${request.role}:${request.attempt}`;
      try {
        const result = await budgetGate.run(request, (limited) => {
          activeAgents.add(identity);
          options.onProgress?.({
            phase: "agent",
            taskId: request.taskId,
            role: request.role,
            state: "running",
            activeAgents: activeAgents.size,
          });
          return bundle.runtime.run(limited);
        });
        activeAgents.delete(identity);
        options.onProgress?.({
          phase: "agent",
          taskId: request.taskId,
          role: request.role,
          state: result.outcome,
          activeAgents: activeAgents.size,
          usage: result.usage,
          cumulativeUsage: options.repo.totalsForWorkspace(),
          provenance: result.provenance ?? null,
        });
        options.signal.throwIfAborted();
        return result;
      } catch (error) {
        if (activeAgents.delete(identity))
          options.onProgress?.({
            phase: "agent",
            taskId: request.taskId,
            role: request.role,
            state: "failed",
            activeAgents: activeAgents.size,
            reason: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    },
  };
  pipeline.credentials = bundle.credentials;

  try {
    if (phaseRank(options.through) >= phaseRank("inventory")) {
      options.signal.throwIfAborted();
      options.repo.updateRunPhase(run.id, "inventory");
      await phaseInventory(pipeline);
    }
    if (phaseRank(options.through) >= phaseRank("baseline")) {
      options.signal.throwIfAborted();
      options.repo.updateRunPhase(run.id, "baseline");
      await phaseBaseline(pipeline);
    }
    if (phaseRank(options.through) >= phaseRank("analyze")) {
      options.signal.throwIfAborted();
      options.repo.updateRunPhase(run.id, "analyze");
      await phaseAnalyze(pipeline);
    }
    if (phaseRank(options.through) >= phaseRank("plan")) {
      options.signal.throwIfAborted();
      options.repo.updateRunPhase(run.id, "plan");
      await phasePlan(pipeline);
    }
    if (
      options.execute &&
      phaseRank(options.through) >= phaseRank("implement")
    ) {
      options.signal.throwIfAborted();
      options.repo.updateRunPhase(run.id, "implement");
      await phaseImplement(pipeline);
    }
    if (
      options.execute &&
      phaseRank(options.through) >= phaseRank("validate")
    ) {
      options.signal.throwIfAborted();
      options.repo.updateRunPhase(run.id, "validate");
      await phaseValidate(pipeline);
    }
    if (phaseRank(options.through) >= phaseRank("report")) {
      options.signal.throwIfAborted();
      options.repo.updateRunPhase(run.id, "report");
      await phaseReport(pipeline);
    }
    options.repo.finishRun(
      run.id,
      blocked.length > 0 || failed.length > 0 ? "incomplete" : "completed",
      {
        blocked,
        failed,
        skipped,
      },
    );
    return { reached: options.through, blocked, failed, skipped };
  } finally {
    pipeline.leases.releaseAll();
  }
}

async function phaseInventory(run: PipelineRun): Promise<void> {
  const { workspace } = run.options;
  const state = run.state;
  const snapshot = readSnapshotRecord(workspace.paths.evidenceInventory);
  await verifySnapshot(workspace.paths.source, snapshot);
  if (workspace.config.host !== null) {
    const host = HostSnapshotSchema.parse(
      readJsonFile(workspace.config.host.snapshotPath),
    );
    state.probe = {
      gm2godotVersion: host.gm2godotVersion,
      pythonVersion: "host-managed",
      pythonExecutable: "host-managed",
      checkout: "host-managed",
      commit: null,
    };
    state.bridge = host.inventory;
    state.gmlApi = host.gmlApiEntries;
  } else {
    const bridgeOptions = {
      checkout: workspace.config.gm2godot.checkout,
      python: state.python,
    };
    state.probe = await probeGm2Godot(
      bridgeOptions,
      workspace.config.gm2godot.expectedVersions,
    );
    state.bridge = await bridgeInventory(bridgeOptions, workspace.paths.source);
    state.gmlApi = await bridgeGmlApi(bridgeOptions);
  }
  const baselineDir = existsSync(
    join(workspace.paths.baseline, MANIFEST_RELATIVE_PATH),
  )
    ? workspace.paths.baseline
    : null;
  state.inventory = await buildInventory({
    snapshot,
    snapshotDir: workspace.paths.source,
    baselineDir,
    baselineId: state.baselineId,
    bridge: state.bridge,
    probe: state.probe,
    gmlApiEntries: state.gmlApi,
    evidenceInventoryDir: workspace.paths.evidenceInventory,
  });
  run.options.logger.info(
    `inventory: ${String(state.inventory.counts.total)} file(s), ${String(state.inventory.counts.unitsTotal)} unit(s), ${String(state.inventory.counts.unitsRequiringAnalysis)} requiring analysis`,
  );
}

async function phaseBaseline(run: PipelineRun): Promise<void> {
  const { workspace } = run.options;
  const state = run.state;
  if (workspace.config.host !== null) {
    const snapshot = SnapshotRecordSchema.parse(
      readJsonFile(join(workspace.root, "host-baseline.json")),
    );
    await verifySnapshot(workspace.paths.baseline, snapshot);
    state.baselineId = snapshot.snapshotId;
    await refreshInventoryWithBaseline(run, workspace.paths.baseline);
    return;
  }
  const existingManifest = join(
    workspace.paths.baseline,
    MANIFEST_RELATIVE_PATH,
  );
  if (existsSync(existingManifest)) {
    const provenance = readBaselineProvenance(workspace.paths.baseline);
    const evidence: BaselineEvidence = readBaselineEvidence(
      workspace.paths.evidenceInventory,
    );
    if (provenance.fresh && evidence.baselineId === provenance.baselineId) {
      run.options.logger.info(
        `baseline: reusing recorded generation ${provenance.baselineId}`,
      );
      await refreshInventoryWithBaseline(run, workspace.paths.baseline);
      return;
    }
    run.options.logger.warn(
      `baseline: existing generation is not fresh (${provenance.reasons.join("; ")}); regenerating`,
    );
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
    allowStaleBaseline: run.options.allowStaleBaseline,
    onAttempt: (evidence) =>
      run.options.repo.recordBaselineAttempt({
        id: newId("attempt"),
        exitCode: evidence.exitCode ?? -1,
        state: evidence.state,
        // Pre-promotion evidence labels the outcome `rejected:*` by design. Freshness is proven by
        // the manifest/attempt provenance, not by that temporary label; partial is valid when updated
        // and verified just like success.
        fresh:
          (evidence.state === "success" || evidence.state === "partial") &&
          evidence.manifestSha256 !== null &&
          evidence.reasons.length === 0,
        detail: evidence,
      }),
  });
  state.baselineId =
    result.provenance?.baselineId ?? result.evidence.baselineId;
  run.options.logger.info(
    `baseline: ${result.interpretation.outcome} (exit ${String(result.exitCode)}) -> ${result.godotProjectDir}`,
  );
  await refreshInventoryWithBaseline(run, workspace.paths.baseline);
}

async function refreshInventoryWithBaseline(
  run: PipelineRun,
  baselineDir: string,
): Promise<void> {
  const { workspace } = run.options;
  const state = run.state;
  if (state.bridge === null || state.probe === null) return;
  const snapshot = readSnapshotRecord(workspace.paths.evidenceInventory);
  state.inventory = await buildInventory({
    snapshot,
    snapshotDir: workspace.paths.source,
    baselineDir,
    baselineId: state.baselineId,
    bridge: state.bridge,
    probe: state.probe,
    gmlApiEntries: state.gmlApi,
    evidenceInventoryDir: workspace.paths.evidenceInventory,
  });
}

/**
 * `port/` starts as a writable copy of the frozen baseline. The baseline itself is never modified: every
 * agent edit lands in `port/` through publication, and the converter's own evidence stays under
 * `baseline/gm2godot/`.
 */
export function ensurePort(run: PipelineRun): string {
  const { workspace } = run.options;
  const port = workspace.paths.port;
  if (existsSync(join(port, "project.godot"))) return port;
  if (!existsSync(join(workspace.paths.baseline, "project.godot"))) {
    throw new DeepError(
      "GM2DEEP-PORT-UNSEEDED",
      "the port has no project.godot and the baseline holds no Godot project to seed it from",
      { port, baseline: workspace.paths.baseline },
    );
  }
  removeTree(port);
  mkdirSync(port, { recursive: true });
  copyTree(workspace.paths.baseline, port);
  thawTree(port);
  run.options.logger.info(
    `port: seeded from the frozen baseline at ${workspace.paths.baseline}`,
  );
  return port;
}

export function toolContextFor(
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

export { phaseAnalyze, phaseImplement, phasePlan, phaseReport, phaseValidate };

/** Re-exported so a caller holding only `pipeline.ts` can type a patch payload built elsewhere. */
export type { PatchRecordPayload };
