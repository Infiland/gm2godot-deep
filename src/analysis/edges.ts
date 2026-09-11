/**
 * Dependency-graph vocabulary: edge kinds, confidence levels, and the shapes the graph, the cycle
 * detector and the analysis record all share. Kept separate from `analysis/gml/types.ts` so the GML
 * scanner has no opinion about the project graph.
 */

export const EDGE_KINDS = [
  "calls",
  "instance_creation",
  "inherits",
  "room_creation",
  "resource_reference",
  "shared_state",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export const CONFIDENCES = ["confirmed", "inferred", "unresolved"] as const;

export type EdgeConfidence = (typeof CONFIDENCES)[number];

export interface EvidenceLocation {
  readonly path: string;
  /** Digest of the file the location points at, so a record can be checked for staleness. */
  readonly sha256: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
}

export interface DependencyEdge {
  readonly id: string;
  /** Source unit id. */
  readonly from: string;
  /** Target unit id. */
  readonly to: string;
  readonly kind: EdgeKind;
  readonly confidence: EdgeConfidence;
  readonly evidence: readonly EvidenceLocation[];
  /** Why an `inferred` or `unresolved` edge could not be confirmed. */
  readonly basis?: string;
}

/** A call to a GML API function; carries the upstream support status it was resolved against. */
export interface ApiUsageRecord {
  readonly id: string;
  readonly unitId: string;
  readonly api: string;
  readonly status: string;
  readonly issueNumber: number;
  readonly ownerModule: string;
  readonly evidence: readonly EvidenceLocation[];
}

/** A symbol the static analysis refused to resolve, with the reason it refused. */
export interface SymbolUnresolvedRecord {
  readonly unitId: string;
  readonly symbol: string;
  readonly reason: string;
  readonly evidence: readonly EvidenceLocation[];
}

export interface DependencyReport {
  readonly edges: readonly DependencyEdge[];
  readonly apiUsage: readonly ApiUsageRecord[];
  readonly unresolved: readonly SymbolUnresolvedRecord[];
}

export function edgeId(from: string, to: string, kind: EdgeKind): string {
  return `${from}->${to}:${kind}`;
}

export function apiUsageId(unitId: string, api: string): string {
  return `${unitId}:api:${api}`;
}

/** Kinds that participate in cycle detection and therefore in task grouping. */
export const SCHEDULING_EDGE_KINDS: readonly EdgeKind[] = [
  "calls",
  "instance_creation",
  "inherits",
  "room_creation",
  "resource_reference",
];
