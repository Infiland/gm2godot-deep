import { provenanceForResult } from "../evidence/provenance.ts";
import { z } from "zod";
import { DeepError } from "../util/result.ts";
import { canonicalJson } from "../util/json.ts";
import { nowIso } from "../util/ids.ts";
import { createLogger, type Logger } from "../util/log.ts";
import { buildToolSpecs } from "../agents/toolSpecs.ts";
import { roleConfig } from "../agents/roles.ts";
import { reconcilerSystemPrompt } from "../agents/prompts.ts";
import type { AgentRuntime, ToolContext } from "../agents/runtime.ts";
import type {
  AnalysisRecord,
  ContractRecord,
  PlanRecord,
  ProducedBy,
} from "../evidence/schemas.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import type { DependencyReport } from "../analysis/edges.ts";
import type { InventoryRecord } from "../indexing/inventory.ts";
import type { Repo } from "../storage/repo.ts";
import type { TaskRecord } from "../storage/types.ts";
import type { Workspace } from "../workspaces/workspace.ts";
import { writeContract, writePlan } from "../evidence/store.ts";

export interface ReconcilerPayload {
  readonly contracts: readonly {
    concern: string;
    version: number;
    rules: ContractRecord["rules"];
  }[];
  readonly unitStrategies: readonly {
    unitId: string;
    strategy: AnalysisRecord["strategy"];
    rationale: string;
  }[];
  readonly conflictResolutions: readonly {
    concern: string;
    resolution: string;
    evidence: unknown[];
  }[];
  readonly blockages: readonly {
    unitId: string;
    reason: string;
    requiredApproval: string;
  }[];
}

export interface ReconcileInput {
  readonly workspace: Workspace;
  readonly repo: Repo;
  readonly runtime: AgentRuntime;
  readonly inventory: InventoryRecord;
  readonly units: readonly AnalysisUnit[];
  readonly analyses: ReadonlyMap<string, AnalysisRecord>;
  readonly dependencies: DependencyReport;
  readonly seeds: readonly ContractRecord[];
  readonly planVersion: number;
  readonly producedBy: ProducedBy;
  readonly signal: AbortSignal;
  readonly maxTurns: number;
  readonly timeoutSeconds: number;
  readonly budgets: {
    readonly tokens: number | null;
    readonly costUsd: number | null;
  };
  readonly credentials: Readonly<Record<string, string>>;
  readonly logger?: Logger;
}

/**
 * Reject a reconciler payload that names an unknown unit, omits a unit, changes a unit's strategy without a
 * stated reason, or rewrites a seeded contract without citing an analysis with evidence.
 */
export function validateReconcilerPayload(
  payload: ReconcilerPayload,
  input: {
    readonly unitIds: readonly string[];
    readonly analyses: ReadonlyMap<string, AnalysisRecord>;
    readonly seeds: readonly ContractRecord[];
  },
): readonly string[] {
  const problems: string[] = [];
  const known = new Set(input.unitIds);
  const seedByConcern = new Map(
    input.seeds.map((seed) => [seed.concern, seed]),
  );

  for (const strategy of payload.unitStrategies) {
    if (!known.has(strategy.unitId)) {
      problems.push(`unitStrategies names unknown unit ${strategy.unitId}`);
      continue;
    }
    const analysis = input.analyses.get(strategy.unitId);
    if (analysis === undefined) {
      problems.push(
        `unitStrategies names ${strategy.unitId}, which has no validated analysis`,
      );
      continue;
    }
    if (
      analysis.strategy !== strategy.strategy &&
      strategy.rationale.trim().length < 20
    ) {
      problems.push(
        `unitStrategies changes ${strategy.unitId} from ${analysis.strategy} to ${strategy.strategy} without a stated reason`,
      );
    }
  }

  for (const contract of payload.contracts) {
    const seed = seedByConcern.get(contract.concern);
    if (seed === undefined) {
      problems.push(
        `contracts adds concern ${contract.concern}, which was not seeded from upstream evidence`,
      );
      continue;
    }
    const changed =
      canonicalJson(contract.rules.map((rule) => rule.statement)) !==
      canonicalJson(seed.rules.map((rule) => rule.statement));
    if (
      changed &&
      !contract.rules.some(
        (rule) => rule.basis === "analysis" && rule.evidence.length > 0,
      )
    ) {
      problems.push(
        `contracts changes ${contract.concern} from the seeded version without citing an analysis with evidence`,
      );
    }
  }

  const covered = new Set(payload.unitStrategies.map((entry) => entry.unitId));
  for (const unitId of input.unitIds) {
    if (!covered.has(unitId)) problems.push(`unitStrategies omits ${unitId}`);
  }
  return problems;
}

export interface ReconcileOutcome {
  readonly plan: PlanRecord;
  readonly contracts: readonly ContractRecord[];
  readonly planPath: string;
  readonly contractPaths: readonly string[];
  readonly problems: readonly string[];
}

function compactAnalysis(record: AnalysisRecord): unknown {
  return {
    unitId: record.unitId,
    unitKind: record.unitKind,
    strategy: record.strategy,
    strategyRationale: record.strategyRationale.text,
    hazards: record.hazards.map(
      (hazard) => `${hazard.id}: ${hazard.description}`,
    ),
    uncertainties: record.uncertainties.map((entry) => entry.text),
    blockers: record.blockers.map((entry) => entry.text),
    sharedState: record.sharedState.map(
      (state) => `${state.name}:${state.access}`,
    ),
    dependencies: record.dependencies.confirmed.map(
      (edge) => `${edge.kind}->${edge.toUnitId}`,
    ),
    unresolved: record.dependencies.unresolved.map(
      (entry) => `${entry.symbol}: ${entry.reason}`,
    ),
    acceptanceScenarios: record.acceptanceScenarios.map(
      (scenario) => `${scenario.id}(${scenario.kind})`,
    ),
  };
}

const RECONCILER_READ_ALLOWLIST = [
  "evidence:contracts",
  "evidence:plans",
  "evidence:analyses",
  "evidence:inventory/inventory.json",
  "evidence:inventory/gml-api.json",
  "evidence:inventory/baseline.json",
];

function syntheticTask(): TaskRecord {
  const at = nowIso();
  return {
    id: "reconcile",
    unitIds: [],
    role: "reconciler",
    state: "READY",
    strategy: "repair_generated",
    attempt: 1,
    maxAttempts: 1,
    allowlist: { read: RECONCILER_READ_ALLOWLIST, write: [] },
    dependsOn: [],
    contractVersions: {},
    inputHash: "reconcile",
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

function reconcilerTools(
  input: ReconcileInput,
  logger: Logger,
): {
  specs: ReturnType<typeof buildToolSpecs>;
  context: ToolContext;
  resultSchema: z.ZodTypeAny;
} {
  const task = syntheticTask();
  const context: ToolContext = {
    role: "reconciler",
    taskId: task.id,
    workspaceRoots: {
      source: input.workspace.paths.source,
      baseline: input.workspace.paths.baseline,
      port: input.workspace.paths.port,
      task: input.workspace.paths.tasks,
      evidence: input.workspace.paths.evidence,
    },
    allowlist: task.allowlist,
    logger,
    recordPolicyDenial: () => {},
    signal: input.signal,
    attempt: 1,
  };
  return {
    specs: buildToolSpecs("reconciler", {
      context,
      task,
      unitId: task.id,
      unitSourcePaths: [],
      unitGeneratedOutputs: [],
      converterDiagnostics: [],
      inventory: input.inventory,
    }),
    context,
    resultSchema: roleConfig("reconciler").resultSchema,
  };
}

/**
 * Run the reconciler role over the per-unit analyses and turn its payload into published contracts and a
 * plan. A payload that violates the plan contract is rejected rather than published.
 */
export async function reconcile(
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  const logger = input.logger ?? createLogger({ level: "warn" });
  const unitIds = input.units
    .filter((unit) => unit.analysisRequired)
    .map((unit) => unit.id)
    .sort();
  const tools = reconcilerTools(input, logger);
  const analyses = unitIds
    .map((unitId) => input.analyses.get(unitId))
    .filter((entry): entry is AnalysisRecord => entry !== undefined);

  const result = await input.runtime.run({
    role: "reconciler",
    taskId: "reconcile",
    systemPrompt: reconcilerSystemPrompt({
      contracts: input.seeds,
      dependencySummary: `${input.dependencies.edges.length} edge(s), ${input.dependencies.unresolved.length} unresolved reference(s), ${unitIds.length} unit(s)`,
    }),
    userPrompt: [
      "Reconcile the per-unit analyses below into contracts and strategies.",
      "Unit analyses:",
      canonicalJson(analyses.map(compactAnalysis)),
      "Seeded contracts (cite the analysis when you change one):",
      canonicalJson(
        input.seeds.map((seed) => ({
          concern: seed.concern,
          version: seed.version,
          rules: seed.rules,
        })),
      ),
      `Units requiring a strategy: ${unitIds.join(", ")}`,
    ].join("\n\n"),
    tools: tools.specs,
    workspaceRoots: tools.context.workspaceRoots,
    allowlist: tools.context.allowlist,
    resultSchema: tools.resultSchema,
    maxTurns: input.maxTurns,
    timeoutSeconds: input.timeoutSeconds,
    budgets: input.budgets,
    signal: input.signal,
    credentials: input.credentials,
    attempt: 1,
    logger,
    recordPolicyDenial: () => {},
  });

  if (result.outcome !== "completed" || result.result === undefined) {
    throw new DeepError(
      "GM2DEEP-PLAN-UNPRODUCED",
      `the reconciler did not produce a plan: ${result.outcome}`,
      {
        outcome: result.outcome,
        reason: result.reason ?? null,
        transcriptPath: result.transcriptPath,
      },
    );
  }

  const producedBy = provenanceForResult(input.producedBy, result);
  const payload = result.result as ReconcilerPayload;
  const problems = validateReconcilerPayload(payload, {
    unitIds,
    analyses: input.analyses,
    seeds: input.seeds,
  });
  if (problems.length > 0) {
    throw new DeepError(
      "GM2DEEP-PLAN-INVALID",
      "the reconciler payload violates the plan contract",
      { problems },
    );
  }

  const byConcern = new Map(
    payload.contracts.map((contract) => [contract.concern, contract]),
  );
  const contracts: ContractRecord[] = input.seeds.map((seed) => {
    const replacement = byConcern.get(seed.concern);
    return replacement === undefined
      ? seed
      : { ...seed, version: replacement.version, rules: replacement.rules };
  });

  const plan: PlanRecord = {
    schemaVersion: 1,
    version: input.planVersion,
    createdAt: nowIso(),
    contracts: contracts.map((contract) => ({
      concern: contract.concern,
      version: contract.version,
      rules: contract.rules,
    })),
    unitStrategies: payload.unitStrategies.map((entry) => ({
      unitId: entry.unitId,
      strategy: entry.strategy,
      rationale: entry.rationale,
    })),
    conflictResolutions: payload.conflictResolutions.map((entry) => ({
      concern: entry.concern,
      resolution: entry.resolution,
      evidence:
        entry.evidence as PlanRecord["conflictResolutions"][number]["evidence"],
    })),
    blockages: payload.blockages.map((entry) => ({ ...entry })),
    producedBy,
  };

  const contractPaths: string[] = [];
  for (const contract of contracts) {
    const written = writeContract(input.workspace.paths.evidenceContracts, {
      ...contract,
      producedBy,
    });
    contractPaths.push(written.path);
    input.repo.upsertContract({
      concern: contract.concern,
      version: contract.version,
      path: written.path,
      sha256: written.sha256,
      policy: contract.policy,
    });
    for (const unitId of unitIds) {
      for (const rule of contract.rules) {
        input.repo.bindContractRule(
          contract.concern,
          contract.version,
          unitId,
          rule.id,
        );
      }
    }
  }
  const planWritten = writePlan(input.workspace.paths.evidencePlans, plan);
  return {
    plan,
    contracts,
    planPath: planWritten.path,
    contractPaths,
    problems,
  };
}
