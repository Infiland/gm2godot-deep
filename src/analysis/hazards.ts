/**
 * Hazard records: every recorded reason the ported behaviour may not match GameMaker, in the one
 * shape the analysis record and the report consume.
 *
 * Two sources are distinguished by `kind`:
 * - `upstream_unsupported_api` — the call targets a GML API whose upstream status is `partial`,
 *   `planned` or `unsupported` (the converter's own API manifest is the authority; the observed
 *   vocabulary is exactly `implemented|partial|unsupported|planned`).
 * - `converter_diagnostic` — the converter itself emitted an `error` or `warning` for this unit's
 *   source. These are converter diagnostics, **not** upstream GML API statuses, which is why they
 *   carry `api: ""`, `issueNumber: 0` and their own status marker. Labelling them as
 *   `upstream_unsupported_api` would state something upstream never said.
 */

import type { AnalysisUnit } from "../indexing/units.ts";
import { apiUsageId, type DependencyReport, type EvidenceLocation } from "./edges.ts";

export const HAZARD_KINDS = ["upstream_unsupported_api", "converter_diagnostic"] as const;

export type HazardKind = (typeof HAZARD_KINDS)[number];

export interface HazardRecord {
  readonly id: string;
  readonly kind: HazardKind;
  readonly api: string;
  readonly status: string;
  readonly issueNumber: number;
  readonly unitId: string;
  readonly description: string;
  readonly evidence: readonly EvidenceLocation[];
}

/** The converter's own `conversion_diagnostics.json` severity vocabulary. */
const HAZARDOUS_DIAGNOSTIC_SEVERITIES: readonly string[] = ["error", "warning"];

/** Statuses that mean "this GML API does not fully work upstream"; anything else is ignored. */
const HAZARDOUS_API_STATUSES: readonly string[] = ["partial", "planned", "unsupported"];

/** The converter's diagnostic shape, as far as a hazard needs it. */
export interface ConverterDiagnosticLike {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly sourcePath?: string | undefined;
  readonly line?: number | undefined;
}

/**
 * Hazards from the dependency report's GML API usage. Usages attributed to a unit id absent from
 * `units` are skipped: after `applyGroups` merges a cycle into one unit, the caller remaps usage
 * records to the merged id, because a hazard cannot be attributed to a unit that no longer exists.
 */
export function hazardsFromApiUsage(
  report: DependencyReport,
  units: readonly AnalysisUnit[],
): readonly HazardRecord[] {
  const known = new Set(units.map((unit) => unit.id));
  const hazards: HazardRecord[] = [];
  const seen = new Set<string>();
  for (const usage of report.apiUsage) {
    if (!HAZARDOUS_API_STATUSES.includes(usage.status)) continue;
    if (!known.has(usage.unitId)) continue;
    const id = apiUsageId(usage.unitId, usage.api);
    if (seen.has(id)) continue;
    seen.add(id);
    const issue = usage.issueNumber > 0 ? ` (upstream issue #${usage.issueNumber})` : "";
    hazards.push({
      id,
      kind: "upstream_unsupported_api",
      api: usage.api,
      status: usage.status,
      issueNumber: usage.issueNumber,
      unitId: usage.unitId,
      description: `GML API '${usage.api}' has upstream status '${usage.status}'${issue}; the generated call may not reproduce GameMaker behaviour.`,
      evidence: usage.evidence,
    });
  }
  return hazards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Hazards from a unit's converter diagnostics at severity `error` or `warning`. `sourcePath` is used
 * as the evidence path when present, with line/column 1 as the fallback; the diagnostic message is
 * the evidence snippet. Duplicate ids (same code and line) collapse to the first occurrence, because
 * `id` is the hazard identity key.
 */
export function hazardsFromDiagnostics(
  unitId: string,
  diagnostics: readonly ConverterDiagnosticLike[],
  /** Digests of the unit's source files, keyed by the path the diagnostic reports. */
  sha256ByPath: ReadonlyMap<string, string> = new Map(),
): readonly HazardRecord[] {
  const hazards: HazardRecord[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (!HAZARDOUS_DIAGNOSTIC_SEVERITIES.includes(diagnostic.severity)) continue;
    const id = `${unitId}:diag:${diagnostic.code}:${diagnostic.line ?? 0}`;
    if (seen.has(id)) continue;
    seen.add(id);
    hazards.push({
      id,
      kind: "converter_diagnostic",
      api: "",
      status: "converter_diagnostic",
      issueNumber: 0,
      unitId,
      description: `GM2Godot reported ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`,
      // A diagnostic that names a file with no recorded digest cannot be cited as evidence, so the
      // location is omitted rather than attached to a path that might not exist.
      evidence: (() => {
        const path = diagnostic.sourcePath;
        const sha256 = path === undefined ? undefined : sha256ByPath.get(path);
        return path === undefined || sha256 === undefined
          ? []
          : [{ path, sha256, line: diagnostic.line ?? 1, column: 1, snippet: diagnostic.message }];
      })(),
    });
  }
  return hazards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
