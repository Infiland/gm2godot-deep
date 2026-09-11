import type { AnalysisRecord, ContractRecord, ReviewRecord } from "../evidence/schemas.ts";
import type { DependencyReport } from "../analysis/edges.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import type { UnitGroup } from "../analysis/cycles.ts";
import { riskScore, reviewRequired } from "./risk.ts";
import type { PlanRecord } from "../evidence/schemas.ts";
import type { Allowlist, RiskAssessment, TaskBudgets, UnitStrategy } from "../storage/types.ts";
import { canonicalJson } from "../util/json.ts";
import { sha256Text } from "../util/sha256.ts";

export interface ImplementationTaskDraft {
  readonly id: string;
  readonly unitIds: readonly string[];
  readonly strategy: UnitStrategy;
  readonly allowlist: Allowlist;
  readonly dependsOn: readonly string[];
  readonly contractVersions: Record<string, number>;
  readonly inputHash: string;
  readonly acceptanceCheckIds: readonly string[];
  readonly reviewRequired: boolean;
  readonly budgets: TaskBudgets;
  readonly blockReason: string | null;
  readonly retainedReason: string | null;
}

export interface TaskPlanningInput {
  readonly units: readonly AnalysisUnit[];
  readonly groups: readonly UnitGroup[];
  readonly analyses: ReadonlyMap<string, AnalysisRecord>;
  readonly reviews: ReadonlyMap<string, ReviewRecord>;
  readonly dependencies: DependencyReport;
  readonly contracts: readonly ContractRecord[];
  readonly plan: PlanRecord;
  readonly risks: ReadonlyMap<string, RiskAssessment>;
  readonly policy: {
    readonly requireReviewFor: readonly ("shared_interface" | "high_risk" | "contract_change")[];
    readonly maxTaskAttempts: number;
    readonly taskTimeoutSeconds: number;
    readonly perTaskTokens: number | null;
    readonly perTaskCostUsd: number | null;
  };
}

export interface TaskPlanningResult {
  readonly tasks: readonly ImplementationTaskDraft[];
  readonly retained: readonly { unitId: string; reason: string }[];
  readonly blocked: readonly { unitId: string; reason: string }[];
}

/**
 * Deterministic input hash for a task: the unit's source hashes, its contract versions, the baseline id
 * and the write allowlist. A patch recorded against a different hash is rejected on integration.
 */
export function taskInputHash(input: {
  readonly unitIds: readonly string[];
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly contractVersions: Readonly<Record<string, number>>;
  readonly baselineId: string | null;
  readonly writeAllowlist: readonly string[];
}): string {
  return sha256Text(canonicalJson(input));
}

const RETAINED_REASON = "generated output is adequate; rewriting it is not justified by any recorded hazard";

/**
 * One task per unit — or per cycle/shared-output group — for every unit whose strategy is not
 * `retain_generated`. Write allowlists are the narrowest possible: only that unit's generated outputs.
 */
export function planTasks(input: TaskPlanningInput): TaskPlanningResult {
  const byUnit = new Map(input.units.map((unit) => [unit.id, unit]));
  const isSharedInterface = sharedInterfaceUnits(input.dependencies);
  const tasks: ImplementationTaskDraft[] = [];
  const retained: { unitId: string; reason: string }[] = [];
  const blocked: { unitId: string; reason: string }[] = [];

  const strategies = new Map(input.plan.unitStrategies.map((entry) => [entry.unitId, entry.strategy]));
  const cycleMembership = new Map<string, UnitGroup>();
  for (const group of input.groups) {
    if (group.kind !== "cycle") continue;
    for (const unitId of group.unitIds) cycleMembership.set(unitId, group);
  }

  const scheduled = new Set<string>();
  const scheduledGroups: { group: UnitGroup; members: AnalysisUnit[] }[] = [];

  for (const group of input.groups) {
    if (group.kind !== "cycle") continue;
    const members = group.unitIds.map((id) => byUnit.get(id)).filter((unit): unit is AnalysisUnit => unit !== undefined);
    if (members.length === 0) continue;
    for (const member of members) scheduled.add(member.id);
    scheduledGroups.push({ group, members });
  }
  for (const unit of input.units) {
    if (!scheduled.has(unit.id)) scheduledGroups.push({ group: { id: unit.id, kind: "shared_output", reason: "single unit", unitIds: [unit.id] }, members: [unit] });
  }

  for (const { group, members } of scheduledGroups) {
    const groupStrategies = members.map(
      (member) => strategies.get(member.id) ?? input.analyses.get(member.id)?.strategy ?? "retain_generated",
    );
    if (groupStrategies.every((strategy) => strategy === "retain_generated")) {
      for (const member of members) retained.push({ unitId: member.id, reason: RETAINED_REASON });
      continue;
    }
    const strategy: UnitStrategy = groupStrategies.includes("blocked")
      ? "blocked"
      : groupStrategies.includes("replace_component")
        ? "replace_component"
        : "repair_generated";

    const write = [...new Set(members.flatMap((member) => member.generatedOutputs.map((output) => output.path)))].sort();
    const read = [
      ...new Set([
        ...members.flatMap((member) => member.sourcePaths.map((path) => `source:${path}`)),
        ...members.flatMap((member) => member.generatedOutputs.map((output) => `baseline:${output.path}`)),
        "evidence:contracts",
        "evidence:inventory/inventory.json",
      ]),
    ].sort();

    const sourceHashes: Record<string, string> = {};
    for (const member of members) Object.assign(sourceHashes, member.sourceHashes);

    const contractVersions = Object.fromEntries(
      input.contracts.map((contract) => [contract.concern, contract.version]),
    );
    const acceptanceCheckIds = members
      .flatMap((member) => input.analyses.get(member.id)?.acceptanceScenarios.map((scenario) => scenario.id) ?? [])
      .sort();
    const groupRisk: RiskAssessment = {
      level: members.some((member) => input.risks.get(member.id)?.level === "high")
        ? "high"
        : members.some((member) => input.risks.get(member.id)?.level === "medium")
          ? "medium"
          : "low",
      reasons: members.flatMap((member) => input.risks.get(member.id)?.reasons ?? []),
    };
    const ownsShared = members.some((member) => isSharedInterface.has(member.id));
    const review = reviewRequired({
      risk: groupRisk,
      ownsSharedInterface: ownsShared,
      contractChanged: false,
      requireReviewFor: input.policy.requireReviewFor,
      hasUncertainties: members.some((member) => (input.analyses.get(member.id)?.uncertainties.length ?? 0) > 0),
      contradictsDependency: false,
    });
    const dependencies = members.flatMap((member) =>
      input.dependencies.edges.filter((edge) => edge.from === member.id && edge.confidence === "confirmed"),
    );
    const dependsOnUnits = [
      ...new Set(
        dependencies
          .filter((edge) => edge.kind !== "shared_state" && edge.to !== edge.from)
          .map((edge) => cycleMembership.get(edge.to)?.id ?? edge.to),
      ),
    ].sort();

    const membershipBlockers = members.flatMap((member) => input.analyses.get(member.id)?.blockers ?? []);
    const blockReason =
      strategy === "blocked"
        ? `analysis blocked this unit: ${membershipBlockers.map((blocker) => blocker.text).join("; ") || "unresolved dynamic semantics"}`
        : null;
    if (blockReason !== null) blocked.push({ unitId: group.id, reason: blockReason });

    tasks.push({
      id: taskIdFor(group.id),
      unitIds: members.map((member) => member.id).sort(),
      strategy,
      allowlist: { read, write },
      dependsOn: dependsOnUnits.map(taskIdFor),
      contractVersions,
      inputHash: taskInputHash({
        unitIds: members.map((member) => member.id).sort(),
        sourceHashes,
        contractVersions,
        baselineId: null,
        writeAllowlist: write,
      }),
      acceptanceCheckIds,
      reviewRequired: review.required,
      budgets: {
        maxAttempts: input.policy.maxTaskAttempts,
        maxModelTokens: input.policy.perTaskTokens,
        maxCostUsd: input.policy.perTaskCostUsd,
        timeoutSeconds: input.policy.taskTimeoutSeconds,
      },
      blockReason,
      retainedReason: null,
    });
  }

  return {
    tasks: tasks.sort((a, b) => (a.id < b.id ? -1 : 1)),
    retained: retained.sort((a, b) => (a.unitId < b.unitId ? -1 : 1)),
    blocked: blocked.sort((a, b) => (a.unitId < b.unitId ? -1 : 1)),
  };
}

export function taskIdFor(unitId: string): string {
  return `task:${unitId}`;
}

/** Units that other units depend on through a non-shared-state edge own an interface. */
export function sharedInterfaceUnits(dependencies: DependencyReport): Set<string> {
  const owners = new Set<string>();
  for (const edge of dependencies.edges) {
    if (edge.kind === "shared_state") continue;
    if (edge.confidence !== "confirmed") continue;
    owners.add(edge.to);
  }
  return owners;
}

