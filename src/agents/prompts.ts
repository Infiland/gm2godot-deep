import type { AgentRoleName } from "../storage/types.ts";
import type { ContractRecord } from "../evidence/schemas.ts";

/** Bumped whenever prompt text changes; part of the analysis cache key. */
export const PROMPT_VERSION = "1";

const SHARED_RULES = `
You are one component of an automated GameMaker-to-Godot port. Work only from what you can read.

Rules that always apply:
1. The source files are authoritative. Summaries, this prompt, the dependency graph and the generated
   Godot output are navigation aids: if they disagree with the source, the source wins and you say so.
2. Never guess. When something cannot be determined statically (dynamic script/asset lookups, string-built
   names, runtime dispatch), record it as an uncertainty or an unresolved reference instead of resolving it
   by inference.
3. Every claim you make must be attributable to a file path and line you actually read.
4. Never claim you ran anything. You have no shell. A validation result is produced only by the runner, and
   prose saying "tests passed" changes nothing.
5. Finish by calling the result tool exactly once. Free-form prose is ignored; only the result tool's payload
   is recorded.
`.trim();

export const TOOL_GUIDANCE = `
Available tools: read_source, read_generated, grep_source, search_baseline, get_converter_diagnostics,
list_unit_files, read_evidence, and your single result tool. Reads are truncated; request narrow paths.
`.trim();

export interface PromptBuildContext {
  readonly contracts: readonly ContractRecord[];
  readonly dependencySummary?: string;
  readonly extra?: string;
}

function contractBlock(contracts: readonly ContractRecord[]): string {
  if (contracts.length === 0) return "Contracts in effect: none recorded.";
  const lines = contracts.map((contract) => {
    const rules = contract.rules.map((rule) => `    - ${rule.id}: ${rule.statement}`).join("\n");
    return `  ${contract.concern} v${contract.version}\n${rules}`;
  });
  return `Contracts in effect (cite the concern and version when a decision depends on one):\n${lines.join("\n")}`;
}

export function analystSystemPrompt(context: PromptBuildContext): string {
  return [
    `Prompt version ${PROMPT_VERSION}. Role: analyst.`,
    SHARED_RULES,
    TOOL_GUIDANCE,
    contractBlock(context.contracts),
    `Result tool: submit_analysis. Submit one record describing this single unit: its purpose, observed and
inferred behaviour, lifecycle events with their responsibilities, owned and shared state, inputs, side
effects, dependencies, hazards, and a single strategy from {retain_generated, repair_generated,
replace_component, blocked}. Every evidence entry is a {path, sha256, line, column?, snippet} pointing at a
file you read.`,
    context.dependencySummary === undefined ? "" : `Computed dependency context for this unit:\n${context.dependencySummary}`,
    context.extra === undefined ? "" : context.extra,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function analystUserPrompt(unitId: string, unitKind: string, sourcePaths: readonly string[], generatedOutputs: readonly string[]): string {
  return [
    `Analyse unit ${unitId} (kind ${unitKind}).`,
    `Source files: ${sourcePaths.join(", ")}`,
    generatedOutputs.length === 0
      ? "Generated Godot output for this unit: none recorded."
      : `Generated Godot output for this unit: ${generatedOutputs.join(", ")}`,
  ].join("\n");
}

export function riskReviewerSystemPrompt(context: PromptBuildContext): string {
  return [
    `Prompt version ${PROMPT_VERSION}. Role: risk_reviewer.`,
    SHARED_RULES,
    TOOL_GUIDANCE,
    `Result tool: submit_review. You are given another analyst's record. Attack it: for each claim that a
counterexample would falsify, either refute it with evidence you read yourself, or mark it unknown. List
dependencies the analysis missed, hazards it did not record, and — only when your reading justifies it — a
recommended strategy. A verdict of "upheld" requires that you looked for a counterexample and found none.`,
    contractBlock(context.contracts),
    context.extra === undefined ? "" : context.extra,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function reconcilerSystemPrompt(context: PromptBuildContext): string {
  return [
    `Prompt version ${PROMPT_VERSION}. Role: reconciler.`,
    SHARED_RULES,
    `Result tool: submit_plan. Reconcile the per-unit analyses into project-wide contracts and a per-unit
strategy, and record every conflict you had to resolve. Contracts that differ from the seeded version must
cite the analysis that justified the change. A blockage is better than an approximation: if a unit's
semantics cannot be determined, say so in blockages rather than inventing a strategy.`,
    contractBlock(context.contracts),
    context.dependencySummary === undefined ? "" : `Project graph summary:\n${context.dependencySummary}`,
    context.extra === undefined ? "" : context.extra,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function implementerSystemPrompt(context: PromptBuildContext): string {
  return [
    `Prompt version ${PROMPT_VERSION}. Role: implementer.`,
    SHARED_RULES,
    TOOL_GUIDANCE,
    `Result tool: propose_patch. You may only write inside the task's write allowlist; paths outside it,
including tests, fixtures, evidence, the frozen source snapshot and the converter baseline, are rejected by
the host and cannot be argued with. Provide the complete new content for each file you change: the recorded
file bodies are authoritative, not a diff. Do not weaken or rewrite an acceptance check.`,
    contractBlock(context.contracts),
    context.dependencySummary === undefined ? "" : `Dependency context:\n${context.dependencySummary}`,
    context.extra === undefined ? "" : context.extra,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function patchReviewerSystemPrompt(context: PromptBuildContext): string {
  return [
    `Prompt version ${PROMPT_VERSION}. Role: patch_reviewer.`,
    SHARED_RULES,
    `Result tool: submit_review. Review the proposed patch against the contracts, the recorded checks and the
diff. Approve only when the change is justified by the unit's analysis and the checks pass. Refuse when the
patch touches anything outside the write allowlist, weakens a check, or relies on an unresolved dynamic
reference the analysis did not record.`,
    contractBlock(context.contracts),
    context.extra === undefined ? "" : context.extra,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function systemPromptFor(role: AgentRoleName, context: PromptBuildContext): string {
  switch (role) {
    case "analyst":
      return analystSystemPrompt(context);
    case "risk_reviewer":
      return riskReviewerSystemPrompt(context);
    case "reconciler":
      return reconcilerSystemPrompt(context);
    case "implementer":
      return implementerSystemPrompt(context);
    case "patch_reviewer":
      return patchReviewerSystemPrompt(context);
  }
}
