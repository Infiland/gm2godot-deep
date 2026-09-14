import { join } from "node:path";
import { readInventory } from "../indexing/inventory.ts";
import { writeJsonAtomic, writeTextAtomic } from "../util/json.ts";
import type { Workspace } from "../workspaces/workspace.ts";
import type { AnalysisRecord, EvidenceRef } from "./schemas.ts";
import { latestPlanVersion, listAnalyses, readPlan } from "./store.ts";

function citations(refs: readonly EvidenceRef[]): string {
  return refs
    .map((ref) => `${ref.path}:${ref.line} (${ref.sha256})`)
    .join("; ");
}
function list(title: string, entries: readonly string[]): string[] {
  return [
    `### ${title}`,
    "",
    ...(entries.length
      ? entries.map((entry) => `- ${entry}`)
      : ["None recorded."]),
    "",
  ];
}
function unitSection(a: AnalysisRecord): string[] {
  return [
    `## ${a.unitId}`,
    "",
    a.purpose.text,
    `Basis: ${a.purpose.basis}.`,
    "",
    ...list(
      "Observed behavior",
      a.behavior.observed.map(
        (item) => `${item.statement} [${citations(item.evidence)}]`,
      ),
    ),
    ...list(
      "Inferred behavior",
      a.behavior.inferred.map(
        (item) => `${item.statement} (basis: ${item.basis})`,
      ),
    ),
    ...list(
      "Lifecycle",
      a.lifecycle.map(
        (event) =>
          `${event.event}: ${event.responsibilities.map((item) => item.statement).join("; ")} [${citations(event.evidence)}]`,
      ),
    ),
    ...list(
      "Owned state",
      a.ownedState.map(
        (state) =>
          `${state.name}${state.typeHint ? ` (${state.typeHint})` : ""} [${citations(state.evidence)}]`,
      ),
    ),
    ...list(
      "Shared state",
      a.sharedState.map(
        (state) =>
          `${state.name}: ${state.access}${state.isGlobal ? ", global" : ""} [${citations(state.evidence)}]`,
      ),
    ),
    ...list("Inputs and side effects", [
      ...a.inputs.map((input) => `${input.name}: ${input.source}`),
      ...a.sideEffects.map(
        (effect) => `${effect.statement} [${citations(effect.evidence)}]`,
      ),
    ]),
    ...list("Dependencies", [
      ...a.dependencies.confirmed.map(
        (d) => `${d.kind} → ${d.toUnitId} [${citations(d.evidence)}]`,
      ),
      ...a.dependencies.inferred.map(
        (d) => `Inferred ${d.kind} → ${d.toUnitId} [${citations(d.evidence)}]`,
      ),
      ...a.dependencies.unresolved.map(
        (d) => `Unresolved ${d.symbol}: ${d.reason}`,
      ),
    ]),
    "### Conversion instructions",
    "",
    `Strategy: ${a.strategy}. ${a.strategyRationale.text}`,
    "",
    ...(a.conversionInstructions?.length
      ? a.conversionInstructions.flatMap((mapping) => [
          `- ${mapping.sourceConcept} → ${mapping.godotEquivalent}: ${mapping.implementationNotes} [${citations(mapping.evidence)}]`,
        ])
      : [
          "No detailed GDScript mapping was supplied; review this unit before implementing new behavior.",
        ]),
    "",
    ...list(
      "Planned outputs",
      (a.plannedOutputs ?? []).map(
        (output) => `${output.path}: ${output.reason}`,
      ),
    ),
    ...list(
      "Acceptance scenarios",
      a.acceptanceScenarios.map(
        (test) =>
          `${test.id} (${test.kind}): ${test.description}. Expected: ${JSON.stringify(test.expected)}${test.command ? `. Command: ${test.command}` : ""}`,
      ),
    ),
    ...list("Assumptions, uncertainties and blockers", [
      ...a.assumptions.map((x) => `Assumption: ${x.text}`),
      ...a.uncertainties.map((x) => `Uncertain: ${x.text}`),
      ...a.blockers.map((x) => `BLOCKER: ${x.text} [${citations(x.evidence)}]`),
    ]),
    ...list(
      "Evidence",
      a.evidence.map(
        (claim) => `${claim.claim}: ${citations(claim.locations)}`,
      ),
    ),
    ...list(
      "Official documentation",
      (a.documentationCitations ?? []).map(
        (doc) =>
          `[${doc.title}](${doc.url}) — ${doc.version}; retrieved ${doc.retrievedAt}; SHA-256 ${doc.contentHash}`,
      ),
    ),
    ...list(
      "Source files",
      a.sourcePaths.map((source) => `${source.path} (${source.sha256})`),
    ),
  ];
}

/** Reports model findings separately from inventory coverage and actual engine/behavioral validation. */
export function writeResearchReport(
  workspace: Workspace,
): Record<string, string> {
  const inventory = readInventory(workspace.paths.evidenceInventory);
  const analyses = listAnalyses(workspace.paths.evidenceAnalyses);
  const version = latestPlanVersion(workspace.paths.evidencePlans);
  const plan =
    version === null ? null : readPlan(workspace.paths.evidencePlans, version);
  const simulated = workspace.config.agent.runtime === "mock";
  const record = {
    schemaVersion: 1,
    simulated,
    filesAccountedFor: inventory.counts.total,
    analysisRecords: analyses.length,
    units: inventory.counts.unitsTotal,
    plan,
    analyses,
    inventoryPath: join(workspace.paths.evidenceInventory, "inventory.json"),
    engineValidation: "not part of research",
    behavioralVerification: "not performed",
  };
  const research = join(workspace.paths.evidenceReports, "research.json"),
    researchMarkdown = join(workspace.paths.evidenceReports, "research.md");
  writeJsonAtomic(research, record);
  writeTextAtomic(
    researchMarkdown,
    [
      "# Conversion research",
      "",
      `Simulation: ${simulated ? "yes; these are deterministic fixture findings, not AI research" : "no"}.`,
      `${record.filesAccountedFor} files accounted for; ${record.analysisRecords} analysis records across ${record.units} units.`,
      "File accounting and recorded model findings do not prove behavioral equivalence. Engine validation and behavioral verification are reported separately after conversion.",
      "",
      ...analyses.flatMap(unitSection),
      "## Project contracts",
      "",
      ...(plan?.contracts ?? []).flatMap((contract) => [
        `### ${contract.concern} (v${contract.version})`,
        "",
        ...contract.rules.map((rule) => `- ${rule.statement}`),
        "",
      ]),
      ...list(
        "Project blockers",
        (plan?.blockages ?? []).map(
          (block) => `${block.unitId}: ${block.reason}`,
        ),
      ),
    ].join("\n"),
  );
  return {
    research,
    researchMarkdown,
    ...(version === null
      ? {}
      : { plan: join(workspace.paths.evidencePlans, `plan.v${version}.json`) }),
  };
}
