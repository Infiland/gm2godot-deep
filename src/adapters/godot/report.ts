import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assertSupportedFormatVersion } from "../gm2godot/versions.ts";
import { DeepError } from "../../util/result.ts";

/** Upstream `GodotValidationReport` artifact version this adapter can read (godot_validation.py:213). */
export const GODOT_VALIDATION_FORMAT_VERSION = 1;
export const GODOT_VALIDATION_REPORT_RELATIVE_PATH = join("gm2godot", "godot_validation_report.json");

const godotOutputIssueSchema = z.strictObject({
  severity: z.enum(["warning", "error"]),
  /** Upstream stores the offending output line itself, not a line number. */
  line: z.string(),
});

const godotValidationReportSchema = z.strictObject({
  format_version: z.literal(1),
  status: z.enum(["passed", "failed", "skipped"]),
  godot_binary: z.string(),
  project_path: z.string(),
  resource_count: z.number().int().nonnegative(),
  resource_paths: z.array(z.string()),
  returncode: z.number().int().nullable(),
  import_returncode: z.number().int().nullable(),
  boot_returncode: z.number().int().nullable(),
  import_output: z.string(),
  boot_output: z.string(),
  output: z.string(),
  boot_frames: z.number().int().nonnegative(),
  output_issue_count: z.number().int().nonnegative(),
  output_error_count: z.number().int().nonnegative(),
  output_warning_count: z.number().int().nonnegative(),
  output_issues: z.array(godotOutputIssueSchema),
  message: z.string(),
});

export type GodotValidationReport = z.infer<typeof godotValidationReportSchema>;

/** Returned when no report exists: a skipped check, never a passed one. */
export interface GodotValidationReportMissing {
  readonly status: "skipped";
  readonly reason: string;
}

export type GodotValidationReading = GodotValidationReport | GodotValidationReportMissing;

export function isGodotValidationReportMissing(
  reading: GodotValidationReading,
): reading is GodotValidationReportMissing {
  return "reason" in reading;
}

/**
 * Read GM2Godot's own Godot validation report. A missing file is `{status:"skipped"}` with a reason;
 * anything present that this adapter cannot read exactly — wrong `format_version`, unknown keys,
 * wrong field types — throws so a caller can never mistake an unread artifact for a passing check.
 */
export function readGodotValidationReport(projectDir: string): GodotValidationReading {
  const reportPath = join(projectDir, GODOT_VALIDATION_REPORT_RELATIVE_PATH);
  if (!existsSync(reportPath)) {
    return { status: "skipped", reason: "godot validation report not found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new DeepError(
      "GM2DEEP-UPSTREAM-INVALID-REPORT",
      `could not parse the Godot validation report: ${error instanceof Error ? error.message : String(error)}`,
      { reportPath },
    );
  }
  const envelope = z.object({ format_version: z.unknown() }).safeParse(parsed);
  if (!envelope.success) {
    throw new DeepError("GM2DEEP-UPSTREAM-INVALID-REPORT", "Godot validation report is not a JSON object", {
      reportPath,
    });
  }
  const observedFormatVersion = envelope.data.format_version;
  assertSupportedFormatVersion(
    `godot_validation_report.json (${reportPath}) schema`,
    observedFormatVersion,
    GODOT_VALIDATION_FORMAT_VERSION,
  );
  const report = godotValidationReportSchema.safeParse(parsed);
  if (!report.success) {
    throw new DeepError(
      "GM2DEEP-UPSTREAM-UNSUPPORTED-SCHEMA",
      `godot_validation_report.json does not match the format_version ${GODOT_VALIDATION_FORMAT_VERSION} schema`,
      { reportPath, artifact: GODOT_VALIDATION_REPORT_RELATIVE_PATH, issues: report.error.issues },
    );
  }
  return report.data;
}
