import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DeepError } from "../../util/result.ts";
import { sha256Bytes } from "../../util/sha256.ts";
import { readJsonFile, writeJsonAtomic } from "../../util/json.ts";
import { nowIso } from "../../util/ids.ts";
import { spawnCapture } from "../../util/proc.ts";
import { repoRoot } from "../../util/package.ts";
import { buildSubprocessEnv } from "../../sandbox/env.ts";
import { allocateStagingDir, copyTree, promoteDirectory } from "../../workspaces/staging.ts";
import { freezeTree } from "../../workspaces/snapshot.ts";
import { interpretConversionExit, type ConversionExitInterpretation } from "./exitCodes.ts";
import {
  ATTEMPT_RELATIVE_PATH,
  BASELINE_NOT_FRESH,
  MANIFEST_RELATIVE_PATH,
  readBaselineProvenance,
  type BaselineProvenance,
} from "./manifest.ts";
import type { Config } from "../../config/schema.ts";

export const MAIN_PY_RELATIVE = "main.py";
export const BASELINE_EVIDENCE_FILENAME = "baseline.json";

export interface BaselineToolchain {
  readonly gm2godotVersion: string | null;
  readonly gm2godotCommit: string | null;
  readonly pythonVersion: string | null;
}

export interface BaselineGenerationRequest {
  /** Frozen source snapshot directory; copied into staging so GM2Godot never sees a frozen tree. */
  readonly sourceDir: string;
  readonly baselineDir: string;
  readonly stagingRoot: string;
  /** `<workspace>/evidence/inventory` — where `baseline.json` is written. */
  readonly evidenceInventoryDir: string;
  readonly config: Config;
  readonly python: string;
  readonly toolchain: BaselineToolchain;
  readonly allowStaleBaseline?: boolean;
  /** Called for every attempt, fresh or not, so the caller can record the attempt ledger. */
  readonly onAttempt?: (evidence: BaselineEvidence) => void;
}

export interface BaselineGenerationResult {
  readonly exitCode: number | null;
  readonly interpretation: ConversionExitInterpretation;
  readonly provenance: BaselineProvenance | null;
  readonly evidence: BaselineEvidence;
  /** The staged project directory when not promoted, the promoted baseline when it was. */
  readonly godotProjectDir: string;
  readonly reportsDir: string;
  readonly stagingDir: string;
  readonly argv: readonly string[];
  readonly durationMs: number;
  readonly promoted: boolean;
}

const PreservedGenerationSchema = z.strictObject({
  present: z.boolean(),
  status: z.string().nullable(),
  currentOutput: z.string().nullable(),
  sha256: z.string().nullable(),
});

export const BaselineEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baselineId: z.string().nullable(),
  generatedAt: z.string().min(1),
  gm2godot: z.strictObject({
    version: z.string().nullable(),
    commit: z.string().nullable(),
    checkout: z.string().min(1),
    python: z.string().min(1),
    pythonVersion: z.string().nullable(),
    platform: z.string().min(1),
    groups: z.array(z.string()),
    only: z.array(z.string()),
  }),
  exitCode: z.number().int().nullable(),
  state: z.string().min(1),
  outcome: z.string().min(1),
  summaryLine: z.string().nullable(),
  manifestSha256: z.string().nullable(),
  attemptSha256: z.string().nullable(),
  generationInventoryFormatVersion: z.number().int().nullable(),
  entryCount: z.number().int().nonnegative(),
  preservedGeneration: PreservedGenerationSchema.nullable(),
  reasons: z.array(z.string()),
  godotProjectDir: z.string().min(1),
  reportsDir: z.string().min(1),
});
export type BaselineEvidence = z.output<typeof BaselineEvidenceSchema>;

function conversionArguments(
  request: BaselineGenerationRequest,
  stagedSource: string,
  stagedGodot: string,
  reportsDir: string,
): string[] {
  const args = [
    "convert",
    "--gm-project",
    stagedSource,
    "--godot-project",
    stagedGodot,
    "--target-platform",
    request.config.gm2godot.platform,
    "--groups",
    request.config.gm2godot.groups.join(","),
    "--report-dir",
    reportsDir,
    "--allow-partial",
  ];
  if (request.config.gm2godot.only.length > 0) args.push("--only", request.config.gm2godot.only.join(","));
  return args;
}

/**
 * Convert into a fresh staging directory, prove the generation is fresh, and only then promote it into
 * `baseline/`. GM2Godot owns its destination transactionally and must never be handed a tree an agent
 * has modified, so the destination is always a rename of untouched converter output.
 */
export async function generateBaseline(request: BaselineGenerationRequest): Promise<BaselineGenerationResult> {
  // GM2Godot's project-options discovery silently finds nothing for a relative --gm-project path, so
  // every path handed to it is resolved first.
  const stagingDir = resolve(allocateStagingDir(resolve(request.stagingRoot), "baseline"));
  const stagedSource = join(stagingDir, "source");
  const stagedGodot = join(stagingDir, "godot");
  const reportsDir = join(stagingDir, "reports");
  copyTree(request.sourceDir, stagedSource);

  const argv = [
    request.python,
    join(request.config.gm2godot.checkout, MAIN_PY_RELATIVE),
    ...conversionArguments(request, stagedSource, stagedGodot, reportsDir),
  ];
  const run = await spawnCapture({
    argv,
    cwd: repoRoot,
    env: buildSubprocessEnv({ PYTHONDONTWRITEBYTECODE: "1" }),
    timeoutSeconds: request.config.gm2godot.timeoutSeconds,
  });

  const interpretation = interpretConversionExit({
    code: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    allowPartial: request.config.gm2godot.allowPartial,
  });
  const provenance = existsSync(join(stagedGodot, MANIFEST_RELATIVE_PATH))
    ? readBaselineProvenance(stagedGodot)
    : null;

  const evidence = buildEvidence(request, {
    interpretation,
    provenance,
    exitCode: run.exitCode,
    godotProjectDir: stagedGodot,
    reportsDir,
    promoted: false,
  });
  request.onAttempt?.(evidence);

  if (provenance === null || !provenance.fresh) {
    if (provenance !== null && request.allowStaleBaseline === true) {
      // Explicitly accepted by the caller; still recorded as non-fresh.
    } else {
      throw new DeepError(
        BASELINE_NOT_FRESH,
        `the conversion at ${stagedGodot} does not describe a fresh generation`,
        {
          reasons: provenance?.reasons ?? ["no conversion manifest was produced"],
          attemptState: provenance?.attemptState ?? null,
          preservedGeneration: provenance?.preservedGeneration ?? null,
          evidence,
        },
      );
    }
  }

  promoteDirectory(stagedGodot, request.baselineDir);
  freezeTree(request.baselineDir);
  const promotedEvidence: BaselineEvidence = {
    ...evidence,
    outcome: interpretation.outcome,
    godotProjectDir: request.baselineDir,
  };
  writeJsonAtomic(join(request.evidenceInventoryDir, BASELINE_EVIDENCE_FILENAME), promotedEvidence);

  return {
    exitCode: run.exitCode,
    interpretation,
    provenance,
    evidence: promotedEvidence,
    godotProjectDir: request.baselineDir,
    reportsDir,
    stagingDir,
    argv,
    durationMs: run.durationMs,
    promoted: true,
  };
}

function buildEvidence(
  request: BaselineGenerationRequest,
  observed: {
    interpretation: ConversionExitInterpretation;
    provenance: BaselineProvenance | null;
    exitCode: number | null;
    godotProjectDir: string;
    reportsDir: string;
    promoted: boolean;
  },
): BaselineEvidence {
  const manifestPath = join(observed.godotProjectDir, MANIFEST_RELATIVE_PATH);
  const attemptPath = join(observed.godotProjectDir, ATTEMPT_RELATIVE_PATH);
  return {
    schemaVersion: 1,
    baselineId: observed.provenance?.baselineId ?? null,
    generatedAt: nowIso(),
    gm2godot: {
      version: request.toolchain.gm2godotVersion,
      commit: request.toolchain.gm2godotCommit,
      checkout: request.config.gm2godot.checkout,
      python: request.python,
      pythonVersion: request.toolchain.pythonVersion,
      platform: request.config.gm2godot.platform,
      groups: request.config.gm2godot.groups,
      only: request.config.gm2godot.only,
    },
    exitCode: observed.exitCode,
    state: observed.interpretation.state ?? "unknown",
    outcome: observed.promoted ? observed.interpretation.outcome : `rejected:${observed.interpretation.outcome}`,
    summaryLine: observed.interpretation.summaryLine,
    manifestSha256: existsSync(manifestPath) ? sha256Bytes(readFileSync(manifestPath)) : null,
    attemptSha256: existsSync(attemptPath) ? sha256Bytes(readFileSync(attemptPath)) : null,
    generationInventoryFormatVersion: observed.provenance?.manifest?.generation_inventory.format_version ?? null,
    entryCount: observed.provenance?.inventoryEntryCount ?? 0,
    preservedGeneration: observed.provenance?.preservedGeneration ?? null,
    reasons: [...(observed.provenance?.reasons ?? ["no conversion manifest was produced"])],
    godotProjectDir: observed.godotProjectDir,
    reportsDir: observed.reportsDir,
  };
}

export function readBaselineEvidence(evidenceInventoryDir: string): BaselineEvidence {
  const path = join(evidenceInventoryDir, BASELINE_EVIDENCE_FILENAME);
  if (!existsSync(path)) {
    throw new DeepError("GM2DEEP-BASELINE-EVIDENCE-MISSING", `no baseline evidence at ${path}`, { path });
  }
  return BaselineEvidenceSchema.parse(readJsonFile(path));
}
