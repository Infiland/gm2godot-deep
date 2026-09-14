/**
 * Phase orchestration: analyze → plan → implement → validate → report.
 *
 * Every phase receives the single {@link PipelineRun} context, so no phase ever reaches for a collaborator
 * that was not handed to it. Identity and provenance fields on every artifact written here are host-owned:
 * a model describes what it found, never who it is or what it ran against.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  diagnosticsForUnit,
  readConversionDiagnostics,
} from "../adapters/gm2godot/diagnostics.ts";
import { mockStrategy, type MockFacts } from "../agents/mock/script.ts";
import { ROLE_CONFIGS } from "../agents/roles.ts";
import { type ToolBuildDeps } from "../agents/toolSpecs.ts";
import { readSnapshotRecord } from "../indexing/inventory.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import type { TaskRecord } from "../storage/types.ts";
import { nowIso } from "../util/ids.ts";
import { DeepError } from "../util/result.ts";
import { sha256Bytes } from "../util/sha256.ts";
import {
  toolContextFor,
  type PipelineRun,
  type UnitRuntimeContext,
} from "./pipeline.ts";

function readUnitSource(
  snapshotDir: string,
  path: string,
): { path: string; sha256: string; lines: string[] } {
  const text = readFileSync(join(snapshotDir, path), "utf8");
  return {
    path,
    sha256: sha256Bytes(Buffer.from(text, "utf8")),
    lines: text.split("\n"),
  };
}

/** A synthetic task record, so a unit-scoped tool context can exist before any task row does. */
export function syntheticTask(
  role: TaskRecord["role"],
  id: string,
  keep: number,
): TaskRecord {
  const at = nowIso();
  return {
    id,
    unitIds: [id],
    role,
    state: "READY",
    strategy: "repair_generated",
    attempt: 1,
    maxAttempts: keep,
    allowlist: { read: [], write: [] },
    dependsOn: [],
    contractVersions: {},
    inputHash: id,
    acceptanceCheckIds: [],
    reviewRequired: false,
    budgets: {
      maxAttempts: 1,
      maxModelTokens: null,
      maxCostUsd: null,
      timeoutSeconds: 600,
    },
    blockReason: null,
    publishedRevision: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function syntheticAnalystTask(
  unit: AnalysisUnit,
  relatedPaths: readonly string[],
): TaskRecord {
  const task = syntheticTask("analyst", unit.id, ROLE_CONFIGS.analyst.maxTurns);
  return {
    ...task,
    allowlist: {
      read: [
        ...relatedPaths.map((path) => `source:${path}`),
        ...unit.generatedOutputs.map((output) => `baseline:${output.path}`),
        "evidence:inventory/inventory.json",
        "evidence:inventory/gml-api.json",
        "evidence:inventory/baseline.json",
      ],
      write: [],
    },
    acceptanceCheckIds: [],
    reviewRequired: false,
  };
}

/**
 * The unit a request is scoped to. A cycle group is scheduled as one task, so the implementer's request
 * has to be scoped to the merged composition while the analysis records stay per original unit.
 */
export function unitForTask(
  task: TaskRecord,
  units: readonly AnalysisUnit[],
): AnalysisUnit {
  const members = task.unitIds
    .map((id) => units.find((unit) => unit.id === id))
    .filter((unit): unit is AnalysisUnit => unit !== undefined);
  if (members.length === 1 && members[0] !== undefined) return members[0];
  const sourcePaths: string[] = [];
  const sourceHashes: Record<string, string> = {};
  const generatedOutputs: AnalysisUnit["generatedOutputs"] = [];
  const seen = new Set<string>();
  for (const member of members) {
    for (const path of member.sourcePaths)
      if (!sourcePaths.includes(path)) sourcePaths.push(path);
    Object.assign(sourceHashes, member.sourceHashes);
    for (const output of member.generatedOutputs) {
      if (seen.has(output.path)) continue;
      seen.add(output.path);
      generatedOutputs.push(output);
    }
  }
  return {
    id: task.id,
    kind: members[0]?.kind ?? "script",
    name: members.map((member) => member.name).join("+"),
    sourcePaths,
    sourceHashes,
    generatedOutputs,
    analysisRequired: true,
    memberUnitIds: [...task.unitIds],
  };
}

/** Build the tool context and the deterministic-runtime facts for one scoped unit. */
export function unitContextFor(
  run: PipelineRun,
  task: TaskRecord,
  unit: AnalysisUnit,
  attempt: number,
): UnitRuntimeContext {
  const { workspace } = run.options;
  const inventory = run.state.inventory;
  if (inventory === null) {
    throw new DeepError(
      "GM2DEEP-INVENTORY-MISSING",
      "the inventory must be built before a unit context can exist",
    );
  }
  const dependencies = run.state.dependencies ?? {
    edges: [],
    apiUsage: [],
    unresolved: [],
  };
  const diagnostics = [
    ...diagnosticsForUnit(
      readConversionDiagnostics(workspace.paths.baseline),
      unit.sourcePaths,
    ),
  ];
  const toolDeps: ToolBuildDeps = {
    context: toolContextFor(run.options, task, run.options.signal, (detail) =>
      run.repo.recordInvalidation({
        kind: "policy_denied",
        unitId: unit.id,
        detail,
      }),
    ),
    task,
    unitId: unit.id,
    unitSourcePaths: unit.sourcePaths,
    unitGeneratedOutputs: unit.generatedOutputs.map((output) => output.path),
    converterDiagnostics: diagnostics,
    inventory,
    documentationVersions: {
      gamemaker: run.state.bridge?.project.ideVersion ?? "unknown",
      godot: workspace.config.godot.expectedVersionPrefix,
    },
  };
  const sourceFiles = unit.sourcePaths
    .filter(
      (path) =>
        inventory.files.find((f) => f.path === path)?.classification !==
        "binary_asset",
    )
    .map((path) => readUnitSource(workspace.paths.source, path));
  const portFiles: Record<string, string> = {};
  for (const output of unit.generatedOutputs) {
    const absolute = join(workspace.paths.port, output.path);
    if (
      existsSync(absolute) &&
      /\.(gd|tscn|tres|gdshader|json|godot)$/.test(output.path)
    )
      portFiles[output.path] = readFileSync(absolute, "utf8");
  }
  const facts: MockFacts = {
    unit,
    baselineId: run.state.baselineId,
    sourceSnapshotId: readSnapshotRecord(workspace.paths.evidenceInventory)
      .snapshotId,
    sourceFiles,
    generatedOutputs: unit.generatedOutputs.map((output) => ({
      path: output.path,
      sha256: output.sha256,
    })),
    converterDiagnostics: diagnostics,
    dependencies,
    hazards: run.state.hazards.filter((hazard) => hazard.unitId === unit.id),
    apiUsage: dependencies.apiUsage.filter((usage) => usage.unitId === unit.id),
    unresolved: dependencies.unresolved.filter(
      (entry) => entry.unitId === unit.id,
    ),
    risk: { level: "low", reasons: [] },
    strategy: "retain_generated",
    contractVersions: { ...task.contractVersions },
    writeAllowlist: [...task.allowlist.write],
    portFiles,
    attempt,
  };
  return { toolDeps, facts: { ...facts, strategy: mockStrategy(facts) } };
}

export function turnBudget(
  config: PipelineRun["options"]["workspace"]["config"],
  role: keyof typeof ROLE_CONFIGS,
): {
  maxTurns: number;
  timeoutSeconds: number;
} {
  return {
    maxTurns: Math.min(
      ROLE_CONFIGS[role].maxTurns,
      config.agent.maxTurnsPerTask,
    ),
    timeoutSeconds: Math.min(
      ROLE_CONFIGS[role].defaultTimeoutSeconds,
      config.agent.taskTimeoutSeconds,
    ),
  };
}
