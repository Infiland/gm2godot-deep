import type { AnalysisUnit } from "../indexing/units.ts";
import type { InventoryRecord } from "../indexing/inventory.ts";
import { failedResult, passedInProcessResult } from "./levels.ts";
import type { ValidationResult } from "./levels.ts";

/**
 * Level A coverage: every file in `inventory.json` and every unit carries exactly one disposition.
 *
 * This is **file coverage only**. It is deliberately reported as its own number and is never combined
 * with test coverage or behavioural verification — whether a file was *processed* says nothing about
 * whether the port behaves correctly.
 */

export const COVERAGE_CHECK_ID = "coverage";

export const DISPOSITIONS = [
  "analyzed",
  "retained",
  "repaired",
  "replaced",
  "blocked",
  "deterministic_only",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const EXCLUDED_DISPOSITION_PREFIX = "excluded(";

/** `excluded(<reason>)` with a non-empty reason, or one of the fixed dispositions. */
export function isDisposition(value: string): boolean {
  if ((DISPOSITIONS as readonly string[]).includes(value)) return true;
  if (!value.startsWith(EXCLUDED_DISPOSITION_PREFIX) || !value.endsWith(")")) return false;
  return value.slice(EXCLUDED_DISPOSITION_PREFIX.length, -1).trim().length > 0;
}

export interface CoverageDeps {
  readonly units: readonly AnalysisUnit[];
  readonly inventory: InventoryRecord;
  /** unit id → disposition. */
  readonly dispositions: Readonly<Record<string, string>>;
  /** inventory-relative file path → disposition. */
  readonly fileDispositions: Readonly<Record<string, string>>;
  readonly inputRevision: string;
  readonly checkId?: string;
}

interface CoverageGap {
  readonly path: string;
  readonly detail: string;
}

function percent(accounted: number, total: number): string {
  if (total === 0) return "100.00";
  return ((accounted / total) * 100).toFixed(2);
}

export function checkCoverage(deps: CoverageDeps): ValidationResult {
  const checkId = deps.checkId ?? COVERAGE_CHECK_ID;
  const level = "A" as const;
  const name = "level A coverage — every inventory file and unit carries exactly one disposition (file coverage only)";

  const missingFiles: CoverageGap[] = [];
  const invalidFiles: CoverageGap[] = [];
  for (const file of deps.inventory.files) {
    const disposition = deps.fileDispositions[file.path];
    if (disposition === undefined) {
      missingFiles.push({ path: file.path, detail: "no disposition recorded" });
      continue;
    }
    if (!isDisposition(disposition)) {
      invalidFiles.push({ path: file.path, detail: `invalid disposition ${JSON.stringify(disposition)}` });
      continue;
    }
    if (file.classification === "excluded" && !disposition.startsWith(EXCLUDED_DISPOSITION_PREFIX)) {
      invalidFiles.push({
        path: file.path,
        detail: `file is excluded from the snapshot but its disposition is ${JSON.stringify(disposition)}`,
      });
    }
  }

  const missingUnits: CoverageGap[] = [];
  const invalidUnits: CoverageGap[] = [];
  for (const unit of deps.units) {
    const disposition = deps.dispositions[unit.id];
    if (disposition === undefined) {
      missingUnits.push({ path: unit.id, detail: "no disposition recorded" });
      continue;
    }
    if (!isDisposition(disposition)) {
      invalidUnits.push({ path: unit.id, detail: `invalid disposition ${JSON.stringify(disposition)}` });
    }
  }

  const totalFiles = deps.inventory.files.length;
  const accountedFiles = totalFiles - missingFiles.length - invalidFiles.length;
  const missing = [...missingFiles, ...invalidFiles, ...missingUnits, ...invalidUnits];
  const accountedText = `${String(accountedFiles)}/${String(totalFiles)} files accounted for (${percent(accountedFiles, totalFiles)}%), ${String(deps.units.length - missingUnits.length - invalidUnits.length)}/${String(deps.units.length)} units accounted for`;

  if (missing.length > 0) {
    const detail = [
      missingFiles.length > 0
        ? `${String(missingFiles.length)} inventory file(s) with no disposition: ${missingFiles.map((gap) => gap.path).join(", ")}`
        : null,
      invalidFiles.length > 0
        ? `${String(invalidFiles.length)} file(s) with an unusable disposition: ${invalidFiles.map((gap) => `${gap.path} (${gap.detail})`).join(", ")}`
        : null,
      missingUnits.length > 0
        ? `${String(missingUnits.length)} unit(s) with no disposition: ${missingUnits.map((gap) => gap.path).join(", ")}`
        : null,
      invalidUnits.length > 0
        ? `${String(invalidUnits.length)} unit(s) with an unusable disposition: ${invalidUnits.map((gap) => `${gap.path} (${gap.detail})`).join(", ")}`
        : null,
    ].filter((part): part is string => part !== null);
    return failedResult({
      level,
      checkId,
      name,
      inputRevision: deps.inputRevision,
      reason: `file coverage incomplete: ${accountedText}; ${detail.join("; ")}. This is file coverage only, not test coverage and not behavioural verification.`,
      artifacts: missing.map((gap) => gap.path),
    });
  }

  return passedInProcessResult({
    level,
    checkId,
    name,
    inputRevision: deps.inputRevision,
    command: "in-process: src/validation/coverage.ts#checkCoverage",
    exitStatus: 0,
    reason: `file coverage complete: ${accountedText}. This is file coverage only, not test coverage and not behavioural verification.`,
  });
}
