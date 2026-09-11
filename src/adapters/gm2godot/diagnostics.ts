import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile } from "../../util/json.ts";
import type { ConverterDiagnostic } from "../../evidence/schemas.ts";

export const DIAGNOSTICS_RELATIVE_PATH = "gm2godot/conversion_diagnostics.json";

const DiagnosticSchema = z.looseObject({
  severity: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  source_path: z.string().nullish(),
  line: z.number().int().nullish(),
  column: z.number().int().nullish(),
  resource: z.string().nullish(),
  resource_type: z.string().nullish(),
  event: z.string().nullish(),
  api: z.string().nullish(),
  manifest_entry: z.string().nullish(),
  issue_number: z.number().int().nullish(),
  workaround: z.string().nullish(),
});

const DiagnosticsReportSchema = z.looseObject({
  summary: z.looseObject({
    info: z.number().int(),
    warning: z.number().int(),
    error: z.number().int(),
    total: z.number().int(),
  }),
  diagnostics: z.array(DiagnosticSchema),
  outcome: z.unknown().optional(),
});

export interface ConversionDiagnosticRecord extends ConverterDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

export interface ConversionDiagnostics {
  readonly summary: { info: number; warning: number; error: number; total: number };
  readonly diagnostics: readonly ConversionDiagnosticRecord[];
}

function toRecord(diagnostic: z.output<typeof DiagnosticSchema>): ConversionDiagnosticRecord {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.source_path == null ? {} : { sourcePath: diagnostic.source_path }),
    ...(diagnostic.line == null ? {} : { line: diagnostic.line }),
    ...(diagnostic.resource == null ? {} : { resource: diagnostic.resource }),
    ...(diagnostic.api == null ? {} : { api: diagnostic.api }),
    ...(diagnostic.issue_number == null ? {} : { issueNumber: diagnostic.issue_number }),
  };
}

/** Read the converter's own diagnostics report. Absent report → an empty, explicitly-not-recorded set. */
export function readConversionDiagnostics(baselineDir: string): ConversionDiagnostics {
  const path = join(baselineDir, DIAGNOSTICS_RELATIVE_PATH);
  if (!existsSync(path)) {
    return { summary: { info: 0, warning: 0, error: 0, total: 0 }, diagnostics: [] };
  }
  const parsed = DiagnosticsReportSchema.parse(readJsonFile(path));
  return { summary: parsed.summary, diagnostics: parsed.diagnostics.map(toRecord) };
}

/** Diagnostics attached to a unit: those whose source path is one of the unit's own files. */
export function diagnosticsForUnit(
  diagnostics: ConversionDiagnostics,
  sourcePaths: readonly string[],
): readonly ConversionDiagnosticRecord[] {
  const wanted = new Set(sourcePaths.map((path) => path.split("\\").join("/")));
  return diagnostics.diagnostics.filter((diagnostic) => {
    if (diagnostic.sourcePath === undefined) return false;
    const normalised = diagnostic.sourcePath.split("\\").join("/");
    for (const path of wanted) {
      if (normalised === path || normalised.endsWith(`/${path}`) || path.endsWith(`/${normalised}`)) return true;
    }
    return false;
  });
}
