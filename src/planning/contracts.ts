import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sha256Bytes } from "../util/sha256.ts";
import type { ContractRecord, ContractRule } from "../evidence/schemas.ts";
import type { InventoryRecord } from "../indexing/inventory.ts";
import { readArchitecturePolicy } from "../adapters/gm2godot/manifest.ts";

/**
 * The ten concerns every port has to answer for. Rules are seeded from upstream evidence, never invented:
 * a concern with no upstream basis gets an explicit `basis: "unresolved"` rule plus `policy.needsReview`.
 */
export interface ConcernDefinition {
  readonly concern: string;
  readonly statement: string;
  /** Baseline-relative path patterns whose presence is evidence for this concern. */
  readonly upstreamPatterns: readonly RegExp[];
}

export const CONCERNS: readonly ConcernDefinition[] = [
  {
    concern: "event_scheduling",
    statement: "GameMaker event order is preserved for every object that exists in the port.",
    upstreamPatterns: [/^gm2godot\/managers\/.*\.gd$/, /^objects\/.*\/(Create|Step|Draw|Alarm)_\d+\.gd$/],
  },
  {
    concern: "instance_identity_lifetime",
    statement: "Instance identity and destruction follow the converter's instance registry.",
    upstreamPatterns: [/^gm2godot\/gml_runtime\.gd$/, /^gm2godot\/managers\/.*instance.*\.gd$/],
  },
  {
    concern: "room_transitions_persistent_state",
    statement: "Room transitions and persistent objects behave as the converter's room layer implements them.",
    upstreamPatterns: [/^gm2godot\/managers\/.*room.*\.gd$/, /^rooms\/.*\.tscn$/],
  },
  {
    concern: "global_state",
    statement: "GML globals map onto the generated global accessors and nothing else writes them.",
    upstreamPatterns: [/^gm2godot\/gml_runtime\.gd$/, /^scripts\/.*\.gd$/],
  },
  {
    concern: "callable_context",
    statement: "Method and script calls keep the converter's `self`/`other` semantics.",
    upstreamPatterns: [/^gm2godot\/gml_script_registry\.gd$/, /^gm2godot\/gml_runtime\.gd$/],
  },
  {
    concern: "timing_random",
    statement: "Timing and randomness use the converter's frame/step model.",
    upstreamPatterns: [/^gm2godot\/managers\/.*\.gd$/, /^objects\/.*\/Step_\d+\.gd$/],
  },
  {
    concern: "input",
    statement: "Input is read through the generated input mnemonics.",
    upstreamPatterns: [/^project\.godot$/, /^gm2godot\/managers\/.*input.*\.gd$/],
  },
  {
    concern: "collision_rendering",
    statement: "Collision masks and draw order follow the generated sprite and room definitions.",
    upstreamPatterns: [/^sprites\/.*\.tscn$/, /^rooms\/.*\.tscn$/],
  },
  {
    concern: "save_data",
    statement: "Saved data keeps the converter's serialization boundaries.",
    upstreamPatterns: [/^gm2godot\/managers\/.*save.*\.gd$/, /^gm2godot\/gml_runtime\.gd$/],
  },
  {
    concern: "platform_extension_bridges",
    statement: "Extension and platform calls are bridged by the generated extension stubs.",
    upstreamPatterns: [/^addons\/gm2godot_extensions\/.*/, /^gm2godot\/managers\/.*extension.*\.gd$/],
  },
];

export const CONTRACT_SEED_VERSION = 1;

function listBaselineFiles(baselineDir: string, limit = 20_000): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (found.length >= limit) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const posix = relative(baselineDir, absolute).split(sep).join("/");
      if (posix.endsWith(".gmlmap.json")) continue;
      found.push(posix);
    }
  };
  if (existsSync(baselineDir)) walk(baselineDir);
  found.sort();
  return found;
}

export interface SeedContractsResult {
  readonly contracts: readonly ContractRecord[];
  readonly unresolvedConcerns: readonly string[];
}

function hashBaselineFile(baselineDir: string, path: string): string {
  const absolute = join(baselineDir, path);
  return existsSync(absolute) && statSync(absolute).isFile()
    ? sha256Bytes(readFileSync(absolute))
    : sha256Bytes(Buffer.from("", "utf8"));
}

/**
 * Version-1 contracts derived from the baseline: every rule cites the exact upstream file that justifies
 * it, with that file's real digest, and the converter's own architecture policy is cited when it names the
 * concern.
 */
export function seedContracts(baselineDir: string, inventory: InventoryRecord, version = CONTRACT_SEED_VERSION): SeedContractsResult {
  const files = listBaselineFiles(baselineDir);
  const policy = readArchitecturePolicy(baselineDir);
  const policyText = policy === null ? "" : JSON.stringify(policy.raw);
  const unresolvedConcerns: string[] = [];
  const contracts: ContractRecord[] = [];

  for (const definition of CONCERNS) {
    const matches = files.filter((file) => definition.upstreamPatterns.some((pattern) => pattern.test(file)));
    const policyMentions = policyText.includes(definition.concern.split("_")[0] ?? "");
    const rules: ContractRule[] = [];
    const evidence = matches.slice(0, 5).map((path) => ({
      path,
      sha256: hashBaselineFile(baselineDir, path),
      line: 1,
      column: 1,
      snippet: `upstream file justifying ${definition.concern}`,
    }));

    if (matches.length > 0) {
      rules.push({
        id: `${definition.concern}.r1`,
        statement: definition.statement,
        basis: "upstream",
        upstreamBasis: { path: matches[0] as string },
        evidence,
      });
      if (policyMentions) {
        rules.push({
          id: `${definition.concern}.r2`,
          statement:
            "The converter's recorded architecture policy for this concern is authoritative over any port-side choice.",
          basis: "upstream",
          upstreamBasis: { path: "gm2godot/architecture_policy.json" },
          evidence: [
            {
              path: "gm2godot/architecture_policy.json",
              sha256: hashBaselineFile(baselineDir, "gm2godot/architecture_policy.json"),
              line: 1,
              column: 1,
              snippet: "recorded architecture policy",
            },
          ],
        });
      }
    } else {
      unresolvedConcerns.push(definition.concern);
      rules.push({
        id: `${definition.concern}.r1`,
        statement: `${definition.statement} No upstream file justifies this concern for this project, so the behaviour is unknown.`,
        basis: "unresolved",
        upstreamBasis: null,
        evidence: [],
      });
    }

    contracts.push({
      schemaVersion: 1,
      concern: definition.concern,
      version,
      rules,
      policy: {
        needsReview: matches.length === 0,
        rationale:
          matches.length === 0
            ? "no upstream file matching this concern was found in the baseline"
            : `seeded from ${matches.length} upstream file(s), first ${matches[0] as string}`,
      },
    });
  }

  void inventory;
  return { contracts, unresolvedConcerns };
}
