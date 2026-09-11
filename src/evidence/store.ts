import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DeepError } from "../util/result.ts";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { sha256Bytes } from "../util/sha256.ts";
import { nowIso } from "../util/ids.ts";
import { encodeId } from "./ids.ts";
import {
  AnalysisRecordSchema,
  ContractRecordSchema,
  PlanRecordSchema,
  ReviewRecordSchema,
  ValidationResultSchema,
  type AnalysisRecord,
  type ContractRecord,
  type EvidenceRef,
  type PlanRecord,
  type ReviewRecord,
  type ValidationResult,
} from "./schemas.ts";
import type { Repo } from "../storage/repo.ts";
import type { InventoryRecord } from "../indexing/inventory.ts";

export const EVIDENCE_STALE = "GM2DEEP-EVIDENCE-STALE";

export function analysisPathFor(analysesDir: string, unitId: string): string {
  return join(analysesDir, `${encodeId(unitId)}.json`);
}

export function reviewPathFor(analysesDir: string, unitId: string): string {
  return join(analysesDir, `${encodeId(unitId)}.review.json`);
}

export function contractPathFor(contractsDir: string, concern: string, version: number): string {
  return join(contractsDir, `${encodeId(concern)}.v${version}.json`);
}

export function planPathFor(plansDir: string, version: number): string {
  return join(plansDir, `plan.v${version}.json`);
}

export function validationPathFor(validationDir: string, checkId: string): string {
  return join(validationDir, `${encodeId(checkId)}.json`);
}

function sha256OfJson(value: unknown): string {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

function parseOrThrow<T>(what: string, path: string, schema: SafeParser<T>): T {
  const parsed = schema.safeParse(readJsonFile(path));
  if (!parsed.success) {
    throw new DeepError("GM2DEEP-EVIDENCE-MALFORMED", `${what} at ${path} does not match its schema`, {
      path,
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export function writeAnalysis(analysesDir: string, record: AnalysisRecord): { path: string; sha256: string } {
  const parsed = AnalysisRecordSchema.parse(record);
  const path = analysisPathFor(analysesDir, parsed.unitId);
  writeJsonAtomic(path, parsed);
  return { path, sha256: sha256OfJson(parsed) };
}

export function readAnalysis(analysesDir: string, unitId: string): AnalysisRecord {
  const path = analysisPathFor(analysesDir, unitId);
  if (!existsSync(path)) {
    throw new DeepError("GM2DEEP-EVIDENCE-MISSING", `no analysis record for ${unitId}`, { path, unitId });
  }
  return parseOrThrow<AnalysisRecord>(`analysis record for ${unitId}`, path, AnalysisRecordSchema);
}

export function listAnalyses(analysesDir: string): AnalysisRecord[] {
  if (!existsSync(analysesDir)) return [];
  return readdirSync(analysesDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".review.json"))
    .sort()
    .map((name) => parseOrThrow<AnalysisRecord>("analysis record", join(analysesDir, name), AnalysisRecordSchema));
}

export function writeReview(analysesDir: string, record: ReviewRecord): { path: string; sha256: string } {
  const parsed = ReviewRecordSchema.parse(record);
  const path = reviewPathFor(analysesDir, parsed.unitId);
  writeJsonAtomic(path, parsed);
  return { path, sha256: sha256OfJson(parsed) };
}

export function readReview(analysesDir: string, unitId: string): ReviewRecord | null {
  const path = reviewPathFor(analysesDir, unitId);
  if (!existsSync(path)) return null;
  return parseOrThrow<ReviewRecord>(`review record for ${unitId}`, path, ReviewRecordSchema);
}

export function writeContract(contractsDir: string, record: ContractRecord): { path: string; sha256: string } {
  const parsed = ContractRecordSchema.parse(record);
  const path = contractPathFor(contractsDir, parsed.concern, parsed.version);
  writeJsonAtomic(path, parsed);
  return { path, sha256: sha256OfJson(parsed) };
}

export function readContract(contractsDir: string, concern: string, version: number): ContractRecord {
  return parseOrThrow<ContractRecord>(
    `contract ${concern} v${version}`,
    contractPathFor(contractsDir, concern, version),
    ContractRecordSchema,
  );
}

export function listContracts(contractsDir: string): ContractRecord[] {
  if (!existsSync(contractsDir)) return [];
  return readdirSync(contractsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parseOrThrow<ContractRecord>("contract", join(contractsDir, name), ContractRecordSchema));
}

export function writePlan(plansDir: string, record: PlanRecord): { path: string; sha256: string } {
  const parsed = PlanRecordSchema.parse(record);
  const path = planPathFor(plansDir, parsed.version);
  writeJsonAtomic(path, parsed);
  return { path, sha256: sha256OfJson(parsed) };
}

export function readPlan(plansDir: string, version: number): PlanRecord {
  return parseOrThrow<PlanRecord>(`plan v${version}`, planPathFor(plansDir, version), PlanRecordSchema);
}

export function latestPlanVersion(plansDir: string): number | null {
  if (!existsSync(plansDir)) return null;
  let highest: number | null = null;
  for (const name of readdirSync(plansDir)) {
    const match = /^plan\.v(\d+)\.json$/.exec(name);
    if (match === null) continue;
    const version = Number(match[1]);
    highest = highest === null ? version : Math.max(highest, version);
  }
  return highest;
}

export function writeValidation(validationDir: string, result: ValidationResult): { path: string; sha256: string } {
  const parsed = ValidationResultSchema.parse(result);
  const path = validationPathFor(validationDir, parsed.checkId);
  writeJsonAtomic(path, parsed);
  return { path, sha256: sha256OfJson(parsed) };
}

export function readValidation(validationDir: string, checkId: string): ValidationResult {
  return parseOrThrow<ValidationResult>(
    `validation result ${checkId}`,
    validationPathFor(validationDir, checkId),
    ValidationResultSchema,
  );
}

export function listValidationResults(validationDir: string): ValidationResult[] {
  if (!existsSync(validationDir)) return [];
  return readdirSync(validationDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parseOrThrow<ValidationResult>("validation result", join(validationDir, name), ValidationResultSchema));
}

export function recordValidation(repo: Repo, result: ValidationResult, taskId: string | null = null): void {
  const parsed = ValidationResultSchema.parse(result);
  repo.upsertValidation({
    checkId: parsed.checkId,
    taskId,
    level: parsed.level,
    name: parsed.name,
    state: parsed.state,
    command: parsed.command ?? null,
    engineVersion: parsed.engineVersion ?? null,
    inputRevision: parsed.inputRevision,
    exitStatus: parsed.exitStatus ?? null,
    durationMs: parsed.durationMs ?? null,
    logsPath: parsed.logsPath ?? null,
    artifacts: parsed.artifacts,
    reason: parsed.reason ?? null,
    createdAt: nowIso(),
  });
}

export { readInventory as readInventoryRecord } from "../indexing/inventory.ts";

export interface EvidenceValidationOptions {
  /** Source snapshot directory, used to count lines for every declared location. */
  readonly snapshotDir: string;
  readonly readText?: (absolutePath: string) => string;
}

/**
 * Reject an analysis record whose file references are fabricated or stale: every declared source path
 * and every evidence location must exist in the inventory with a matching sha256, every generated output
 * must be an output of that unit, and every declared line must exist in the file.
 *
 * This does **not** verify that a claim is true. It only proves the record is not built on files that
 * never existed or have since changed.
 */
export function validateAnalysisEvidence(
  record: AnalysisRecord,
  inventory: InventoryRecord,
  options: EvidenceValidationOptions,
): void {
  const hashByPath = new Map(inventory.files.map((file) => [file.path, file.sha256]));
  const unit = inventory.units.find((candidate) => candidate.id === record.unitId);
  if (unit === undefined) {
    throw new DeepError(EVIDENCE_STALE, `analysis record names unknown unit ${record.unitId}`, {
      unitId: record.unitId,
    });
  }

  const problems: { path: string; reason: string }[] = [];
  const check = (ref: { path: string; sha256: string }, what: string): void => {
    const known = hashByPath.get(ref.path);
    if (known === undefined) {
      problems.push({ path: ref.path, reason: `${what}: path is not in the inventory` });
      return;
    }
    if (known !== ref.sha256) {
      problems.push({ path: ref.path, reason: `${what}: sha256 ${ref.sha256} does not match inventory ${known}` });
    }
  };

  for (const source of record.sourcePaths) check(source, "sourcePaths");
  for (const generated of record.generatedOutputs) {
    const known = unit.generatedOutputs.find((candidate) => candidate.path === generated.path);
    if (known === undefined) {
      problems.push({ path: generated.path, reason: "generatedOutputs: path is not an output of this unit" });
    } else if (known.sha256 !== generated.sha256) {
      problems.push({
        path: generated.path,
        reason: `generatedOutputs: sha256 ${generated.sha256} does not match baseline ${known.sha256}`,
      });
    }
  }

  const lineCounts = new Map<string, number | null>();
  const linesOf = (path: string): number | null => {
    const cached = lineCounts.get(path);
    if (cached !== undefined) return cached;
    let value: number | null = null;
    try {
      const text = (options.readText ?? ((absolutePath: string) => readFileSync(absolutePath, "utf8")))(
        join(options.snapshotDir, path),
      );
      value = text.length === 0 ? 0 : text.split("\n").length;
    } catch {
      value = null;
    }
    lineCounts.set(path, value);
    return value;
  };

  const checkLocations = (locations: readonly EvidenceRef[], what: string): void => {
    for (const ref of locations) {
      check(ref, what);
      const lines = linesOf(ref.path);
      if (lines === null) {
        problems.push({ path: ref.path, reason: `${what}: file cannot be read from the snapshot` });
      } else if (ref.line > lines) {
        problems.push({ path: ref.path, reason: `${what}: line ${ref.line} exceeds the file's ${lines} lines` });
      }
    }
  };

  for (const entry of record.evidence) checkLocations(entry.locations, "evidence");
  for (const entry of record.behavior.observed) checkLocations(entry.evidence, "behavior.observed");
  for (const entry of record.lifecycle) checkLocations(entry.evidence, "lifecycle");
  for (const entry of record.ownedState) checkLocations(entry.evidence, "ownedState");
  for (const entry of record.sharedState) checkLocations(entry.evidence, "sharedState");
  for (const entry of record.sideEffects) checkLocations(entry.evidence, "sideEffects");
  for (const entry of record.blockers) checkLocations(entry.evidence, "blockers");
  for (const entry of record.hazards) checkLocations(entry.evidence, "hazards");
  for (const entry of record.dependencies.confirmed) checkLocations(entry.evidence, "dependencies.confirmed");
  for (const entry of record.dependencies.inferred) checkLocations(entry.evidence, "dependencies.inferred");
  for (const entry of record.dependencies.unresolved) checkLocations(entry.evidence, "dependencies.unresolved");

  if (problems.length > 0) {
    throw new DeepError(
      EVIDENCE_STALE,
      `analysis record for ${record.unitId} references stale or fabricated evidence`,
      { unitId: record.unitId, problems: problems.slice(0, 40), problemCount: problems.length },
    );
  }
}
