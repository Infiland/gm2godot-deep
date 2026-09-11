import { sha256Bytes } from "../../util/sha256.ts";
import type { ConverterDiagnostic, EvidenceRef, AgentUsage } from "../../evidence/schemas.ts";
import type { AnalysisUnit } from "../../indexing/units.ts";
import type { ApiUsageRecord, DependencyReport, SymbolUnresolvedRecord } from "../../analysis/edges.ts";
import type { RiskAssessment, UnitStrategy } from "../../storage/types.ts";
import type { ImplementerSubmission } from "../toolSpecs.ts";

/**
 * Deterministic, offline stand-in for a model. Nothing here invents game semantics: every statement is
 * templated over symbols that were actually found on disk, and every payload carries `runtime:"mock"`,
 * `simulated:true` and `usage.reported:false` so no reader can mistake it for a model's work.
 */

export const MOCK_USAGE: AgentUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  reported: false,
};

export interface MockFacts {
  readonly unit: AnalysisUnit;
  readonly baselineId: string | null;
  readonly sourceSnapshotId: string;
  readonly sourceFiles: readonly { path: string; sha256: string; lines: readonly string[] }[];
  readonly generatedOutputs: readonly { path: string; sha256: string }[];
  readonly converterDiagnostics: readonly ConverterDiagnostic[];
  readonly dependencies: DependencyReport;
  readonly hazards: readonly {
    id: string;
    kind: string;
    api: string;
    status: string;
    description: string;
    evidence: readonly EvidenceRef[];
    upstreamIssueNumber?: number;
  }[];
  readonly apiUsage: readonly ApiUsageRecord[];
  readonly unresolved: readonly SymbolUnresolvedRecord[];
  readonly risk: RiskAssessment;
  readonly strategy: UnitStrategy;
  readonly contractVersions: Readonly<Record<string, number>>;
  readonly writeAllowlist: readonly string[];
  readonly portFiles: Readonly<Record<string, string>>;
  /** Attempt number, so the mock can inject its documented first-attempt defect deterministically. */
  readonly attempt: number;
}

function ref(facts: MockFacts, path: string, line: number, snippet: string): EvidenceRef {
  const file = facts.sourceFiles.find((candidate) => candidate.path === path);
  const text = file?.lines[line - 1];
  return {
    path,
    sha256: file?.sha256 ?? sha256Bytes(Buffer.from("", "utf8")),
    line,
    column: 1,
    snippet: snippet.length > 0 ? snippet : (text ?? ""),
  };
}

const EVENT_NAMES: Record<string, string> = {
  Create_0: "create",
  Step_0: "step",
  Step_1: "step_begin",
  Step_2: "step_end",
  Draw_0: "draw",
  Alarm_0: "alarm_0",
  Destroy_0: "destroy",
  RoomStart_0: "room_start",
  RoomEnd_0: "room_end",
  CleanUp_0: "clean_up",
  User_0: "user_0",
  KeyPress_32: "key_press_space",
};

function eventName(fileName: string): string {
  const stem = fileName.replace(/\.gml$/, "");
  return EVENT_NAMES[stem] ?? stem.toLowerCase();
}

/** The reason the mock refuses to rewrite a unit: an unresolved lookup that feeds a resource identity. */
export function blockingUnresolved(facts: MockFacts): readonly SymbolUnresolvedRecord[] {
  const unsupported = new Set(facts.hazards.filter((hazard) => hazard.kind === "upstream_unsupported_api").map((h) => h.api));
  return facts.unresolved.filter(
    (entry) => unsupported.size > 0 && /asset_get_index|script_execute/.test(entry.symbol),
  );
}

export function mockStrategy(facts: MockFacts): UnitStrategy {
  if (blockingUnresolved(facts).length > 0 && facts.hazards.length > 0) return "blocked";
  if (facts.apiUsage.some((usage) => usage.status !== "implemented")) return "repair_generated";
  if (facts.dependencies.edges.some((edge) => edge.kind === "shared_state")) return "repair_generated";
  return "retain_generated";
}

/**
 * A deterministic defect the mock injects on the FIRST attempt of a `repair_generated` task, so the
 * repair loop is exercised end to end without a model. It is documented behaviour of the simulator, not
 * an observation about the port: the second attempt removes it again.
 */
export const MOCK_DEFECT_MARKER = "deep-convert[mock] deliberate first-attempt defect";

export function mockDefectLine(facts: MockFacts): string | null {
  const generated = facts.writeAllowlist.find((path) => path.endsWith(".gd"));
  if (generated === undefined) return null;
  const body = facts.portFiles[generated];
  if (body === undefined || !/counter/.test(body)) return null;
  const counterProperty = /\bglobal_counter\b/.test(body) ? "global_counter" : /counter/.test(body) ? "counter" : null;
  if (counterProperty === null) return null;
  return `\n# ${MOCK_DEFECT_MARKER}\nfunc _deep_mock_defect() -> void:\n\t${counterProperty} += 1\n\nfunc _ready() -> void:\n\t_deep_mock_defect()\n`;
}

export function mockAnalysis(facts: MockFacts): Record<string, unknown> {
  const gmlFiles = facts.sourceFiles.filter((file) => file.path.endsWith(".gml"));
  const eventFiles = gmlFiles.filter((file) => /_[0-9]+\.gml$/.test(file.path));
  const confirmed = facts.dependencies.edges.filter(
    (edge) => edge.from === facts.unit.id && edge.confidence === "confirmed",
  );
  const unresolved = facts.unresolved.filter((entry) => entry.unitId === facts.unit.id);
  const calls = facts.apiUsage.filter((usage) => usage.unitId === facts.unit.id);

  return {
    schemaVersion: 1,
    sourcePaths: facts.sourceFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
    converterDiagnostics: facts.converterDiagnostics,
    purpose: {
      text: `Unit ${facts.unit.id} is a ${facts.unit.kind} composed of ${facts.sourceFiles.length} file(s): ${facts.sourceFiles
        .map((file) => file.path)
        .join(", ")}.`,
      basis: "observed",
    },
    behavior: {
      observed: eventFiles.map((file) => ({
        statement: `${file.path} runs ${file.lines.length} line(s) on the ${eventName(file.path.split("/").pop() ?? "")} event.`,
        evidence: [ref(facts, file.path, 1, file.lines[0] ?? "")],
      })),
      inferred: confirmed
        .filter((edge) => edge.kind === "calls")
        .map((edge) => ({
          statement: `this unit calls ${edge.to.slice(edge.to.indexOf(":") + 1)}`,
          basis: `confirmed ${edge.kind} edge derived from the recorded call graph`,
        })),
    },
    lifecycle: eventFiles.map((file) => ({
      event: eventName(file.path.split("/").pop() ?? ""),
      responsibilities: [
        {
          statement: `${file.path} holds the ${eventName(file.path.split("/").pop() ?? "")} responsibilities of ${facts.unit.name}.`,
          basis: "derived from the event file name and its recorded dependencies",
        },
      ],
      evidence: [ref(facts, file.path, 1, file.lines[0] ?? "")],
    })),
    ownedState: [],
    sharedState: confirmed
      .filter((edge) => edge.kind === "shared_state")
      .map((edge) => ({
        name: edge.evidence[0]?.snippet ?? edge.to,
        isGlobal: true,
        access: "readwrite" as const,
        basis: `the recorded call graph links this unit to ${edge.to}`,
        evidence: edge.evidence,
      })),
    inputs: [],
    sideEffects: [],
    dependencies: {
      confirmed: confirmed.map((edge) => ({ toUnitId: edge.to, kind: edge.kind, evidence: edge.evidence })),
      inferred: facts.dependencies.edges
        .filter((edge) => edge.from === facts.unit.id && edge.confidence === "inferred")
        .map((edge) => ({
          toUnitId: edge.to,
          kind: edge.kind,
          basis: edge.basis ?? "inferred edge recorded by the dependency analyser",
          evidence: edge.evidence,
        })),
      unresolved: unresolved.map((entry) => ({
        symbol: entry.symbol,
        reason: entry.reason,
        evidence: entry.evidence,
      })),
    },
    hazards: facts.hazards.map((hazard) => ({
      id: hazard.id,
      kind: hazard.kind,
      description: hazard.description,
      evidence: hazard.evidence,
      ...(hazard.upstreamIssueNumber === undefined
        ? {}
        : { upstreamIssueNumber: hazard.upstreamIssueNumber }),
    })),
    strategy: facts.strategy,
    strategyRationale: {
      text: strategyRationale(facts),
      basis: "derived from recorded hazards, unresolved references and shared-state edges",
    },
    acceptanceScenarios: [
      {
        id: `${facts.unit.id}:scenario`,
        kind: "synthetic",
        description: `step ${facts.unit.name} through its recorded lifecycle and compare the emitted trace`,
        expected: { provenance: "synthetic", note: "produced from the generated baseline of the synthetic fixture" },
      },
    ],
    assumptions: [],
    uncertainties: unresolved.map((entry) => ({
      text: `${entry.symbol} cannot be resolved statically`,
      basis: entry.reason,
    })),
    blockers: unresolved
      .filter((entry) => /asset_get_index|script_execute/.test(entry.symbol))
      .map((entry) => ({ text: `${entry.symbol} is not statically resolvable`, evidence: entry.evidence })),
    evidence: [
      {
        claim: `unit ${facts.unit.id} is composed of the listed source files`,
        locations: facts.sourceFiles.map((file) => ref(facts, file.path, 1, file.lines[0] ?? "")),
      },
      ...calls.map((usage) => ({
        claim: `this unit calls the GML API ${usage.api} (upstream status ${usage.status})`,
        locations: usage.evidence,
      })),
    ],
  };
}

function strategyRationale(facts: MockFacts): string {
  if (facts.strategy === "blocked") {
    return "an unresolved dynamic reference feeds a resource lookup and the unit carries an unsupported upstream API";
  }
  if (facts.strategy === "repair_generated") {
    const apis = facts.apiUsage.filter((usage) => usage.status !== "implemented").map((usage) => usage.api);
    const shared = facts.dependencies.edges.filter((edge) => edge.kind === "shared_state").length;
    return `generated output needs work: upstream API status ${apis.join(", ") || "n/a"}; ${shared} shared-state edge(s) recorded`;
  }
  return "generated output is adequate; rewriting it is not justified by any recorded hazard";
}

export function mockReview(facts: MockFacts): Record<string, unknown> {
  const claims = facts.sourceFiles.length === 0 ? [] : ["unit composition"];
  return {
    schemaVersion: 1,
    challenges: claims.map((claim) => ({
      claim: `${claim} as recorded by the analyst`,
      counterexampleEvidence: [],
      verdict: "upheld" as const,
    })),
    missedDependencies: [],
    additionalHazards: [],
    recommendedStrategy: facts.strategy,
    reviewerNotes: `mock reviewer: checked ${facts.sourceFiles.length} source file(s) and ${facts.dependencies.edges.length} recorded edge(s) against the analyst record; no counterexample was produced.`,
  };
}

export interface MockPlanInput {
  readonly unitIds: readonly string[];
  readonly strategies: Readonly<Record<string, UnitStrategy>>;
  readonly contracts: readonly { concern: string; version: number; rules: { id: string; statement: string; basis: "upstream" | "analysis" | "unresolved"; upstreamBasis: { path: string } | null; evidence: EvidenceRef[] }[] }[];
}

export function mockPlan(input: MockPlanInput): Record<string, unknown> {
  return {
    schemaVersion: 1,
    contracts: input.contracts.map((contract) => ({
      concern: contract.concern,
      version: contract.version,
      rules: contract.rules,
    })),
    unitStrategies: input.unitIds.map((unitId) => ({
      unitId,
      strategy: input.strategies[unitId] ?? "retain_generated",
      rationale:
        (input.strategies[unitId] ?? "retain_generated") === "retain_generated"
          ? "generated output is adequate; rewriting it is not justified by any recorded hazard"
          : "recorded hazards or shared state require the generated output to be revisited",
    })),
    conflictResolutions: [],
    blockages: input.unitIds
      .filter((unitId) => input.strategies[unitId] === "blocked")
      .map((unitId) => ({
        unitId,
        reason: "an unresolved dynamic reference feeds a resource lookup",
        requiredApproval: "manual review of the dynamic lookup before implementation",
      })),
  };
}

/**
 * Deterministic patch: the generated files in the write allowlist, annotated with a provenance header.
 * For a `repair_generated` unit the first attempt appends the documented mock defect; later attempts do
 * not. Behaviour is otherwise preserved, so the port matched the baseline before any repair.
 */
export function mockPatch(facts: MockFacts): ImplementerSubmission {
  const files = facts.writeAllowlist
    .filter((path) => facts.portFiles[path] !== undefined)
    .map((path) => {
      const preimage = facts.portFiles[path] as string;
      let content = `# gm2godot-deep: ${facts.unit.id} (strategy ${facts.strategy}, contracts ${JSON.stringify(
        facts.contractVersions,
      )})\n${preimage}`;
      if (facts.strategy === "repair_generated" && facts.attempt === 1) {
        const defect = mockDefectLine(facts);
        if (defect !== null && content === `# gm2godot-deep: ${facts.unit.id} (strategy ${facts.strategy}, contracts ${JSON.stringify(
          facts.contractVersions,
        )})\n${preimage}` && path.endsWith(".gd")) {
          content = content + defect;
        }
      }
      return {
        path,
        action: "update" as const,
        preimageSha256: sha256Bytes(Buffer.from(preimage, "utf8")),
        contentSha256: sha256Bytes(Buffer.from(content, "utf8")),
        content,
      };
    });

  return {
    schemaVersion: 1,
    files,
    summary:
      files.length === 0
        ? "no generated file was available in the write allowlist; nothing to change"
        : `annotated ${files.length} generated file(s) with port provenance${
            facts.strategy === "repair_generated" && facts.attempt === 1 ? " and the documented first-attempt defect" : ""
          }`,
  };
}
