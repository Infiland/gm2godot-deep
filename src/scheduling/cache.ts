import { canonicalJson } from "../util/json.ts";
import { sha256Text } from "../util/sha256.ts";
import { ANALYSIS_UNIT_KINDS } from "../indexing/units.ts";
import type { Repo } from "../storage/repo.ts";

/** Bump when the scanner, the dependency builder or the analysis schema changes shape. */
export const ANALYZER_VERSION = "1";
export const ANALYSIS_SCHEMA_VERSION = 1;

export interface CacheKeyInput {
  readonly unitId: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  /** Confirmed and inferred edges of this unit, each with the contract versions in effect. */
  readonly dependencyEdges: readonly {
    readonly to: string;
    readonly kind: string;
    readonly contractVersions: Readonly<Record<string, number>>;
  }[];
  readonly baselineId: string | null;
  readonly gm2godotVersion: string | null;
  readonly godotVersion: string | null;
  readonly promptVersion: string;
  readonly model: string | null;
}

/**
 * The analysis cache key. A contract version bump changes the key of every unit whose dependency edges
 * touch that concern, even when the unit's own `.gml` is unchanged — because the contract is part of what
 * the analysis was written against.
 */
export function analysisCacheKey(input: CacheKeyInput): string {
  const edges = [...input.dependencyEdges]
    .map((edge) => ({ to: edge.to, kind: edge.kind, contractVersions: edge.contractVersions }))
    .sort((a, b) => (a.to === b.to ? (a.kind < b.kind ? -1 : 1) : a.to < b.to ? -1 : 1));
  return sha256Text(
    canonicalJson({
      unitId: input.unitId,
      sourceHashes: input.sourceHashes,
      dependencyEdges: edges,
      baselineId: input.baselineId,
      gm2godotVersion: input.gm2godotVersion,
      godotVersion: input.godotVersion,
      analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      promptVersion: input.promptVersion,
      model: input.model,
      analysisUnitKinds: ANALYSIS_UNIT_KINDS,
    }),
  );
}

export interface CachedAnalysis {
  readonly key: string;
  readonly unitId: string;
  readonly kind: string;
  readonly value: unknown;
}

export class AnalysisCache {
  readonly repo: Repo;

  constructor(repo: Repo) {
    this.repo = repo;
  }

  get(key: string): CachedAnalysis | null {
    const entry = this.repo.getCacheEntry(key);
    if (entry === null) return null;
    return { key: entry.key, unitId: entry.unitId, kind: entry.kind, value: entry.value };
  }

  put(key: string, unitId: string, kind: string, value: unknown): void {
    this.repo.putCacheEntry(key, unitId, kind, value);
  }

  clear(): number {
    return this.repo.clearCache();
  }
}

export interface InvalidationOutcome {
  readonly concern: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly affectedUnitIds: readonly string[];
}

/**
 * Record an invalidation for every unit bound to `concern` at `fromVersion`, drop their cache entries and
 * return the units the scheduler must re-key to READY. Units whose sources are unchanged are re-analysed
 * precisely because the contract they were analysed against changed.
 */
export function invalidateForContractChange(
  repo: Repo,
  concern: string,
  fromVersion: number,
  toVersion: number,
): InvalidationOutcome {
  const bindings = repo.listBindingsForConcern(concern).filter((binding) => binding.version === fromVersion);
  const affected = new Set(bindings.map((binding) => binding.unitId));
  for (const unitId of affected) {
    repo.recordInvalidation({
      kind: "contract_change",
      concern,
      fromVersion,
      toVersion,
      unitId,
      detail: { ruleIds: bindings.filter((binding) => binding.unitId === unitId).map((binding) => binding.ruleId) },
    });
    repo.deleteCacheEntriesForUnit(unitId);
  }
  return { concern, fromVersion, toVersion, affectedUnitIds: [...affected].sort() };
}
