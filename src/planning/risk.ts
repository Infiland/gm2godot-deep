import type { AnalysisRecord, ReviewRecord } from "../evidence/schemas.ts";
import type { DependencyEdge } from "../analysis/edges.ts";
import type { RiskAssessment, RiskLevel, UnitStrategy } from "../storage/types.ts";

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

function escalate(current: RiskLevel, candidate: RiskLevel): RiskLevel {
  return LEVEL_ORDER[candidate] > LEVEL_ORDER[current] ? candidate : current;
}

export interface RiskInput {
  readonly unitId: string;
  readonly record: AnalysisRecord | null;
  readonly review: ReviewRecord | null;
  readonly edges: readonly DependencyEdge[];
  /** Units that depend on this unit, i.e. it exposes an interface others use. */
  readonly dependents: readonly string[];
  readonly inCycle: boolean;
  readonly ownsContractRule: boolean;
  readonly unresolvedFeedsResourceIdentity: boolean;
}

/**
 * Risk is a function of what was recorded, never of how long the unit is: unsupported upstream APIs,
 * unresolved references that decide resource identity, shared-state writes, a `replace_component`
 * strategy, cycle membership, or being an interface other units depend on.
 */
export function riskScore(input: RiskInput): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskLevel = "low";
  const record = input.record;

  if (record === null) {
    return { level: "high", reasons: ["no analysis record was produced, so nothing about this unit is verified"] };
  }

  for (const hazard of record.hazards) {
    if (hazard.kind === "upstream_unsupported_api") {
      level = escalate(level, "high");
      reasons.push(`hazard ${hazard.id}: upstream API is not fully implemented (${hazard.description})`);
    }
  }
  if (input.unresolvedFeedsResourceIdentity) {
    level = escalate(level, "high");
    reasons.push("an unresolved dynamic reference decides which resource is used");
  }
  if (record.strategy === "replace_component") {
    level = escalate(level, "high");
    reasons.push("strategy replace_component discards generated output");
  }
  if (record.strategy === "blocked") {
    level = escalate(level, "high");
    reasons.push("the analysis blocked this unit");
  }
  if (record.sharedState.some((state) => state.access === "write" || state.access === "readwrite")) {
    level = escalate(level, "medium");
    reasons.push("this unit writes shared state");
  }
  if (input.inCycle) {
    level = escalate(level, "medium");
    reasons.push("this unit is part of a dependency cycle and is scheduled as one task");
  }
  if (input.dependents.length > 0) {
    level = escalate(level, "medium");
    reasons.push(`other units depend on this one: ${input.dependents.join(", ")}`);
  }
  if (record.uncertainties.length > 0) {
    level = escalate(level, "medium");
    reasons.push(`${record.uncertainties.length} recorded uncertainty/uncertainties`);
  }
  if (record.blockers.length > 0) {
    level = escalate(level, "high");
    reasons.push(`${record.blockers.length} recorded blocker(s)`);
  }
  if (input.review !== null) {
    const refuted = input.review.challenges.filter((challenge) => challenge.verdict === "refuted");
    if (refuted.length > 0) {
      level = escalate(level, "high");
      reasons.push(`${refuted.length} review challenge(s) refuted the analysis`);
    }
    if (input.review.missedDependencies.length > 0 || input.review.additionalHazards.length > 0) {
      level = escalate(level, "medium");
      reasons.push("the reviewer found dependencies or hazards the analysis missed");
    }
  }
  if (input.ownsContractRule) {
    level = escalate(level, "medium");
    reasons.push("this unit owns a shared contract rule");
  }

  return { level, reasons: reasons.length === 0 ? ["no hazard, unresolved reference or shared state was recorded"] : reasons };
}

export interface ReviewTriggerInput {
  readonly risk: RiskAssessment;
  readonly ownsSharedInterface: boolean;
  readonly contractChanged: boolean;
  readonly requireReviewFor: readonly ("shared_interface" | "high_risk" | "contract_change")[];
  readonly hasUncertainties: boolean;
  readonly contradictsDependency: boolean;
}

export function reviewRequired(input: ReviewTriggerInput): { required: boolean; reasons: readonly string[] } {
  const reasons: string[] = [];
  if (input.requireReviewFor.includes("high_risk") && input.risk.level === "high") reasons.push("risk level is high");
  if (input.requireReviewFor.includes("shared_interface") && input.ownsSharedInterface) {
    reasons.push("the unit implements a shared interface");
  }
  if (input.requireReviewFor.includes("contract_change") && input.contractChanged) {
    reasons.push("a contract rule this unit implements changed");
  }
  if (input.hasUncertainties) reasons.push("the analysis records uncertainties");
  if (input.contradictsDependency) reasons.push("the analysis contradicts an analysis it depends on");
  return { required: reasons.length > 0, reasons };
}

/** A `refuted` challenge means the analysis cannot be trusted; that is an escalation, not a resolution. */
export function contradictionBetween(record: AnalysisRecord, dependency: AnalysisRecord | null): string | null {
  if (dependency === null) return null;
  const edge = record.dependencies.confirmed.find((entry) => entry.toUnitId === dependency.unitId);
  if (edge === undefined) return null;
  const mine = new Set(record.strategy === "blocked" ? ["blocked"] : []);
  if (mine.has(dependency.strategy)) {
    return `this unit is ${record.strategy} but the unit it depends on (${dependency.unitId}) is ${dependency.strategy}`;
  }
  return null;
}

/** A `retain_generated` decision always stands; any other strategy must name what justifies the rewrite. */
export function strategyIsJustified(record: AnalysisRecord): boolean {
  if (record.strategyRationale.text.trim().length < 20) return false;
  if (record.strategy === "retain_generated") return true;
  return record.hazards.length > 0 || record.uncertainties.length > 0 || record.sharedState.length > 0;
}
