import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256Bytes } from "../../util/sha256.ts";
import { DeepError } from "../../util/result.ts";
import { readJsonFile } from "../../util/json.ts";
import {
  SUPPORTED_ARCHITECTURE_POLICY_FORMAT_VERSION,
  SUPPORTED_ATTEMPT_FORMAT_VERSION,
  SUPPORTED_GENERATION_INVENTORY_FORMAT_VERSION,
  SUPPORTED_MANIFEST_FORMAT_VERSION,
  assertSupportedFormatVersion,
} from "./versions.ts";

export const MANIFEST_RELATIVE_PATH = "gm2godot/conversion_manifest.json";
export const ATTEMPT_RELATIVE_PATH = "gm2godot/conversion_attempt.json";
export const ARCHITECTURE_POLICY_RELATIVE_PATH = "gm2godot/architecture_policy.json";

export const BASELINE_NOT_FRESH = "GM2DEEP-BASELINE-NOT-FRESH";

const GenerationInventoryEntrySchema = z.looseObject({
  path: z.string().min(1),
  kind: z.string(),
  owner: z.looseObject({ class: z.string(), name: z.string() }),
  byte_count: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  mode: z.number().int(),
});

const GenerationInventorySchema = z.looseObject({
  format_version: z.number().int(),
  entries: z.array(GenerationInventoryEntrySchema),
});

export const ConversionManifestSchema = z.looseObject({
  format_version: z.number().int(),
  conversion: z.looseObject({
    state: z.string(),
    converters: z.looseObject({
      requested: z.number().int(),
      executed: z.number().int(),
      completed: z.number().int(),
      skipped: z.number().int(),
      failed: z.number().int(),
    }),
    resources: z.looseObject({
      requested: z.number().int(),
      executed: z.number().int(),
      completed: z.number().int(),
      skipped: z.number().int(),
      failed: z.number().int(),
    }),
    failed_step: z.string().nullable(),
    failure_phase: z.string().nullable(),
  }),
  target_platform: z.string(),
  enabled_converters: z.array(z.string()),
  source_project: z.looseObject({
    name: z.string(),
    yyp_path: z.string(),
    resource_type: z.string(),
    resource_version: z.string(),
    ide_version: z.string(),
  }),
  resources: z.array(z.unknown()),
  generation_inventory: GenerationInventorySchema,
  generated_files: z.array(z.looseObject({ path: z.string(), kind: z.string(), sha256: z.string() })),
  source_maps: z.array(z.unknown()),
  architecture_policies: z.unknown(),
  path_diagnostics: z.unknown(),
});

const CanonicalManifestSchema = z.looseObject({
  path: z.string(),
  status: z.string(),
  updated: z.boolean(),
  current_output: z.string(),
  sha256: z.string().nullable(),
});

const ConversionAttemptSchema = z.looseObject({
  format_version: z.number().int(),
  attempt: z.looseObject({
    state: z.string(),
    converters: z.unknown(),
    steps: z.unknown(),
    resources: z.unknown(),
    failed_step: z.string().nullable(),
    failure_phase: z.string().nullable(),
    cancelled: z.boolean(),
  }),
  canonical_manifest: CanonicalManifestSchema,
});

export type ConversionManifest = z.output<typeof ConversionManifestSchema>;
export type ConversionAttempt = z.output<typeof ConversionAttemptSchema>;

export interface PreservedGeneration {
  readonly present: boolean;
  readonly status: string | null;
  readonly currentOutput: string | null;
  readonly sha256: string | null;
}

export interface BaselineProvenance {
  /** True only for a generation this run actually wrote and verified. */
  readonly fresh: boolean;
  readonly attemptState: string | null;
  readonly attemptStateAccepted: boolean;
  readonly manifestFormatVersion: number;
  readonly manifestSha256: string;
  readonly baselineId: string;
  readonly inventoryEntryCount: number;
  readonly preservedGeneration: PreservedGeneration | null;
  readonly reasons: readonly string[];
  readonly manifest: ConversionManifest | null;
}

function readOptionalJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return readJsonFile(path);
}

/**
 * The freshness predicate. A manifest is a *fresh* generation only when the attempt ledger says the run
 * updated and verified it (`status:"updated"`, `updated:true`, `current_output:"verified"`, digest equal
 * to the manifest bytes) **and** the attempt itself reached `success` or `partial`. `status:"preserved"`
 * describes an older generation that survived a failed or cancelled run and can never mean "this run
 * produced the destination".
 */
export function readBaselineProvenance(baselineDir: string, expectedConverters?: number): BaselineProvenance {
  const manifestPath = join(baselineDir, MANIFEST_RELATIVE_PATH);
  const attemptPath = join(baselineDir, ATTEMPT_RELATIVE_PATH);

  if (!existsSync(manifestPath)) {
    throw new DeepError(BASELINE_NOT_FRESH, `no conversion manifest at ${manifestPath}`, {
      baselineDir,
      reasons: ["conversion_manifest.json is absent"],
    });
  }

  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = sha256Bytes(manifestBytes);
  const parsedManifest = ConversionManifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8")));
  if (!parsedManifest.success) {
    throw new DeepError("GM2DEEP-UPSTREAM-MALFORMED", `${manifestPath} does not match the v2 manifest schema`, {
      issues: parsedManifest.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const manifest = parsedManifest.data;
  assertSupportedFormatVersion("conversion_manifest.json format_version", manifest.format_version, SUPPORTED_MANIFEST_FORMAT_VERSION);
  assertSupportedFormatVersion(
    "generation_inventory format_version",
    manifest.generation_inventory.format_version,
    SUPPORTED_GENERATION_INVENTORY_FORMAT_VERSION,
  );

  const reasons: string[] = [];
  let attemptState: string | null = null;
  let attemptStateAccepted = false;
  let preservedGeneration: PreservedGeneration | null = null;

  const rawAttempt = readOptionalJson(attemptPath);
  if (rawAttempt === undefined) {
    reasons.push("conversion_attempt.json is absent, so the generation cannot be proven fresh");
  } else {
    const parsedAttempt = ConversionAttemptSchema.safeParse(rawAttempt);
    if (!parsedAttempt.success) {
      throw new DeepError("GM2DEEP-UPSTREAM-MALFORMED", `${attemptPath} does not match the v1 attempt schema`, {
        issues: parsedAttempt.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const attempt = parsedAttempt.data;
    assertSupportedFormatVersion("conversion_attempt.json format_version", attempt.format_version, SUPPORTED_ATTEMPT_FORMAT_VERSION);
    attemptState = attempt.attempt.state;
    attemptStateAccepted = attemptState === "success" || attemptState === "partial";
    const canonical = attempt.canonical_manifest;

    preservedGeneration = {
      present: canonical.status !== "absent",
      status: canonical.status,
      currentOutput: canonical.current_output,
      sha256: canonical.sha256,
    };

    if (canonical.path !== MANIFEST_RELATIVE_PATH) {
      reasons.push(`attempt canonical manifest path is ${canonical.path}, expected ${MANIFEST_RELATIVE_PATH}`);
    }
    if (canonical.status !== "updated") {
      reasons.push(`attempt canonical manifest status is "${canonical.status}" (preserved or absent, not updated)`);
    }
    if (canonical.updated !== true) reasons.push("attempt canonical manifest updated flag is not true");
    if (canonical.current_output !== "verified") {
      reasons.push(`attempt canonical manifest current_output is "${canonical.current_output}"`);
    }
    if (canonical.sha256 !== manifestSha256) {
      reasons.push(
        `attempt canonical manifest digest ${String(canonical.sha256)} does not match the manifest bytes ${manifestSha256}`,
      );
    }
    if (!attemptStateAccepted) {
      reasons.push(`attempt state is "${attemptState}" (only success or partial can be a fresh generation)`);
    }
  }

  const inventoryEntryCount = manifest.generation_inventory.entries.length;
  if (expectedConverters !== undefined && manifest.conversion.converters.executed !== expectedConverters) {
    reasons.push(
      `manifest records ${manifest.conversion.converters.executed} executed converters, expected ${expectedConverters}`,
    );
  }
  if (inventoryEntryCount === 0) reasons.push("generation inventory lists no entries");

  return {
    fresh: reasons.length === 0,
    attemptState,
    attemptStateAccepted,
    manifestFormatVersion: manifest.format_version,
    manifestSha256,
    baselineId: manifestSha256,
    inventoryEntryCount,
    preservedGeneration,
    reasons,
    manifest,
  };
}

export interface ManagedOutput {
  readonly path: string;
  readonly kind: string;
  readonly ownerClass: string;
  readonly ownerName: string;
  readonly byteCount: number;
  readonly sha256: string;
  readonly mode: number;
}

/**
 * Re-derive the converter-owned file set from the manifest, so the port inherits converter provenance
 * without having to trust a directory walk of the frozen baseline.
 */
export function listManagedOutputs(baselineDir: string): ManagedOutput[] {
  const manifest = ConversionManifestSchema.parse(readJsonFile(join(baselineDir, MANIFEST_RELATIVE_PATH)));
  assertSupportedFormatVersion("conversion_manifest.json format_version", manifest.format_version, SUPPORTED_MANIFEST_FORMAT_VERSION);
  return manifest.generation_inventory.entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    ownerClass: entry.owner.class,
    ownerName: entry.owner.name,
    byteCount: entry.byte_count,
    sha256: entry.sha256,
    mode: entry.mode,
  }));
}

export interface ArchitecturePolicy {
  readonly formatVersion: number;
  readonly raw: unknown;
}

export function readArchitecturePolicy(baselineDir: string): ArchitecturePolicy | null {
  const path = join(baselineDir, ARCHITECTURE_POLICY_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  const parsed: unknown = readJsonFile(path);
  if (typeof parsed !== "object" || parsed === null || !("format_version" in parsed)) {
    throw new DeepError("GM2DEEP-UPSTREAM-MALFORMED", `${path} has no format_version`, { path });
  }
  const version = parsed.format_version;
  assertSupportedFormatVersion(
    "architecture_policy.json format_version",
    version,
    SUPPORTED_ARCHITECTURE_POLICY_FORMAT_VERSION,
  );
  return { formatVersion: version, raw: parsed };
}
