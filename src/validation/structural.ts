import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { ensureDir, writeJsonAtomic } from "../util/json.ts";
import { buildSubprocessEnv } from "../sandbox/env.ts";
import { spawnCapture, stripAnsi } from "../util/proc.ts";
import { exclusionFor } from "../indexing/exclude.ts";
import { probeGodot } from "../adapters/godot/adapter.ts";
import { MAIN_PY_RELATIVE } from "../adapters/gm2godot/adapter.ts";
import {
  GODOT_VALIDATION_REPORT_RELATIVE_PATH,
  isGodotValidationReportMissing,
  readGodotValidationReport,
} from "../adapters/godot/report.ts";
import {
  failedResult,
  inconclusiveResult,
  passedInProcessResult,
  passedResult,
  skippedResult,
} from "./levels.ts";
import type { ValidationResult } from "./levels.ts";
import type { GodotVersionExpectation } from "./godotRun.ts";

/**
 * Level B structural verification, in two independent halves.
 *
 * `structural-static` parses the project's own text (INI-like `project.godot`, `.tscn`/`.tres`
 * resource references, `preload`/`load` literals) and needs no engine, so it can pass on a machine
 * with no Godot installed. `structural-gm2godot` runs the pinned converter's own `validate`
 * subcommand against the same project and inherits its verdict — a `skipped` report is propagated as
 * `skipped`, never as success.
 */

export const STRUCTURAL_STATIC_CHECK_ID = "structural-static";
export const STRUCTURAL_GM2GODOT_CHECK_ID = "structural-gm2godot";
export const STRUCTURAL_STATIC_FINDINGS_FILENAME = "structural-static.json";
export const STRUCTURAL_GM2GODOT_LOG_FILENAME = "structural-gm2godot.log";

/** Path attributes and script references only count when they point at one of these. */
const REFERENCED_EXTENSIONS: readonly string[] = [".gd", ".tscn", ".tres"];
const SCRIPT_EXTENSION = ".gd";
const PROJECT_FILE = "project.godot";
const NOT_FOUND_REASON = "godot binary not configured or not found";

export interface StructuralFinding {
  /** Project-relative file the unresolved reference lives in. */
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly reference: string;
  readonly reason: string;
  readonly snippet: string;
}

export interface StructuralDeps {
  readonly projectPath: string;
  readonly godotBinary: string | null;
  readonly gm2godotCheckout: string;
  readonly python: string;
  readonly timeoutSeconds: number;
  readonly reportDir: string;
  readonly inputRevision: string;
  readonly repoRoot: string;
  readonly expectedGodot?: GodotVersionExpectation;
}

function walkProjectFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const absolute = join(directory, entry.name);
      const posix = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (exclusionFor(`${posix}/`, 0).excluded) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (exclusionFor(posix, statSync(absolute).size).excluded) continue;
      found.push(posix);
    }
  };
  walk(root);
  return found;
}

function hasReferencedExtension(reference: string): boolean {
  const lower = reference.toLowerCase();
  return REFERENCED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function unresolved(
  findings: StructuralFinding[],
  path: string,
  line: number,
  column: number,
  reference: string,
  reason: string,
  snippet: string,
): void {
  findings.push({
    path,
    line,
    column,
    reference,
    reason,
    snippet: snippet.trim().slice(0, 200),
  });
}

/** `res://foo/bar.gd` → absolute path inside the project, or `null` for a non-`res://` value. */
function resolveResReference(
  projectPath: string,
  reference: string,
): string | null {
  if (!reference.startsWith("res://")) return null;
  const inner = reference.slice("res://".length);
  if (inner.length === 0) return null;
  return join(projectPath, ...inner.split("/"));
}

const PATH_ATTRIBUTE = /\bpath\s*=\s*"(res:\/\/[^"]*)"/g;
const SCRIPT_REFERENCE =
  /(?:preload|load)\s*\(\s*("|')(res:\/\/[^"']*)\1\s*\)/g;
const AUTOLOAD_ENTRY = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"\*?(res:\/\/[^"]+)"/;

function checkResReference(
  findings: StructuralFinding[],
  projectPath: string,
  path: string,
  line: number,
  reference: string,
  column: number,
  snippet: string,
): void {
  const resolved = resolveResReference(projectPath, reference);
  if (resolved === null) {
    unresolved(
      findings,
      path,
      line,
      column,
      reference,
      "reference is not a res:// path inside the project",
      snippet,
    );
    return;
  }
  if (!existsSync(resolved)) {
    unresolved(
      findings,
      path,
      line,
      column,
      reference,
      "referenced resource does not exist",
      snippet,
    );
  }
}

function checkProjectGodot(
  projectPath: string,
  findings: StructuralFinding[],
): void {
  const path = PROJECT_FILE;
  const absolute = join(projectPath, path);
  if (!existsSync(absolute)) {
    unresolved(
      findings,
      path,
      1,
      1,
      path,
      "the Godot project file is missing",
      "",
    );
    return;
  }
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  let section = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed.slice(1, -1);
      continue;
    }
    if (section !== "autoload") continue;
    const match = AUTOLOAD_ENTRY.exec(trimmed);
    const reference = match?.[2];
    if (reference === undefined) continue;
    const column = line.indexOf("res://") + 1;
    checkResReference(
      findings,
      projectPath,
      path,
      index + 1,
      reference,
      column <= 0 ? 1 : column,
      line,
    );
  }
}

function checkSceneFile(
  projectPath: string,
  path: string,
  findings: StructuralFinding[],
): void {
  const absolute = join(projectPath, ...path.split("/"));
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    PATH_ATTRIBUTE.lastIndex = 0;
    for (const match of line.matchAll(PATH_ATTRIBUTE)) {
      const reference = match[1];
      if (reference === undefined || !hasReferencedExtension(reference))
        continue;
      const offset = match.index + match[0].indexOf("res://");
      checkResReference(
        findings,
        projectPath,
        path,
        index + 1,
        reference,
        offset + 1,
        line,
      );
    }
  }
}

function checkScriptFile(
  projectPath: string,
  path: string,
  findings: StructuralFinding[],
): void {
  const absolute = join(projectPath, ...path.split("/"));
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const match of line.matchAll(SCRIPT_REFERENCE)) {
      const reference = match[2];
      if (reference === undefined) continue;
      const offset = match.index + match[0].indexOf("res://");
      checkResReference(
        findings,
        projectPath,
        path,
        index + 1,
        reference,
        offset + 1,
        line,
      );
    }
  }
}

/**
 * Parse the project directory itself. Returns the per-reference findings; an empty list is the pass
 * condition. Static only: no engine is consulted and nothing is executed.
 */
export function collectStructuralFindings(
  projectPath: string,
): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  if (!existsSync(projectPath)) {
    unresolved(
      findings,
      projectPath,
      1,
      1,
      projectPath,
      "the godot project directory does not exist",
      "",
    );
    return findings;
  }
  checkProjectGodot(projectPath, findings);
  for (const path of walkProjectFiles(projectPath)) {
    if (path.endsWith(".tscn") || path.endsWith(".tres")) {
      checkSceneFile(projectPath, path, findings);
      continue;
    }
    if (path.endsWith(SCRIPT_EXTENSION))
      checkScriptFile(projectPath, path, findings);
  }
  return findings;
}

export function checkStructuralStatic(deps: {
  readonly projectPath: string;
  readonly inputRevision: string;
  readonly reportDir: string;
}): ValidationResult {
  const startedAt = Date.now();
  const findings = collectStructuralFindings(deps.projectPath);
  if (findings.length === 0) {
    return passedInProcessResult({
      level: "B",
      checkId: STRUCTURAL_STATIC_CHECK_ID,
      name: "level B structural (static) — project.godot, .tscn/.tres references and preload/load literals resolve",
      inputRevision: deps.inputRevision,
      command:
        "in-process: src/validation/structural.ts#collectStructuralFindings",
      exitStatus: 0,
      durationMs: Date.now() - startedAt,
      reason:
        "every res:// reference in project.godot, .tscn, .tres and .gd resolves; no engine was required",
    });
  }
  ensureDir(deps.reportDir);
  const findingsPath = join(
    deps.reportDir,
    STRUCTURAL_STATIC_FINDINGS_FILENAME,
  );
  writeJsonAtomic(findingsPath, {
    schemaVersion: 1,
    projectPath: deps.projectPath,
    findings,
  });
  const listed = findings
    .slice(0, 10)
    .map(
      (finding) =>
        `${finding.path}:${String(finding.line)} → ${finding.reference} (${finding.reason})`,
    )
    .join("; ");
  return failedResult({
    level: "B",
    checkId: STRUCTURAL_STATIC_CHECK_ID,
    name: "level B structural (static) — project.godot, .tscn/.tres references and preload/load literals resolve",
    inputRevision: deps.inputRevision,
    reason: `${String(findings.length)} unresolved reference(s): ${listed}${findings.length > 10 ? ` (+${String(findings.length - 10)} more)` : ""}`,
    durationMs: Date.now() - startedAt,
    artifacts: [findingsPath],
  });
}

async function checkGm2GodotValidate(
  deps: StructuralDeps,
): Promise<ValidationResult> {
  const checkId = STRUCTURAL_GM2GODOT_CHECK_ID;
  const name =
    "level B structural — pinned GM2Godot `validate` over the candidate project";
  const identity = {
    level: "B" as const,
    checkId,
    name,
    inputRevision: deps.inputRevision,
  };

  if (!deps.python || !deps.gm2godotCheckout) {
    return skippedResult({
      ...identity,
      reason:
        "Hosted extension: checkout-based validation is unavailable; static checks and direct Godot validation are reported separately",
    });
  }

  if (deps.godotBinary === null || deps.godotBinary.trim().length === 0) {
    return skippedResult({
      ...identity,
      reason: `${NOT_FOUND_REASON}; structural-gm2godot requires the engine to load generated resources`,
    });
  }

  ensureDir(deps.reportDir);
  const argv = [
    deps.python,
    join(deps.gm2godotCheckout, MAIN_PY_RELATIVE),
    "validate",
    "--godot-project",
    deps.projectPath,
    "--godot-bin",
    deps.godotBinary,
    "--report-dir",
    deps.reportDir,
  ];
  const startedAt = Date.now();
  let captured;
  try {
    captured = await spawnCapture({
      argv,
      cwd: deps.repoRoot,
      env: buildSubprocessEnv({ PYTHONDONTWRITEBYTECODE: "1" }),
      timeoutSeconds: deps.timeoutSeconds,
    });
  } catch (error) {
    return failedResult({
      ...identity,
      reason: `could not run GM2Godot validate: ${error instanceof Error ? error.message : String(error)} (command: ${argv.join(" ")})`,
    });
  }
  const stdout = stripAnsi(captured.stdout);
  const stderr = stripAnsi(captured.stderr);
  const logPath = join(deps.reportDir, STRUCTURAL_GM2GODOT_LOG_FILENAME);
  writeFileSync(
    logPath,
    [
      `# command: ${argv.join(" ")}`,
      "--- stdout ---",
      stdout,
      "--- stderr ---",
      stderr,
      "",
    ].join("\n"),
    "utf8",
  );
  const command = argv.join(" ");
  const durationMs = Date.now() - startedAt;
  const runtimeIdentity = {
    command,
    exitStatus: captured.exitCode,
    durationMs,
    logsPath: logPath,
  };

  const probe = await probeGodot(
    deps.godotBinary,
    deps.expectedGodot ?? { expectedVersion: "", expectedVersionPrefix: "" },
  );
  const reading = readGodotValidationReport(deps.projectPath);

  if (captured.timedOut) {
    return failedResult({
      ...identity,
      ...runtimeIdentity,
      reason: `gm2godot validate timed out after ${String(deps.timeoutSeconds)}s`,
    });
  }

  if (isGodotValidationReportMissing(reading)) {
    if (captured.exitCode !== 0) {
      const firstLine = (
        stderr.trim().split(/\r?\n/)[0] ??
        stdout.trim().split(/\r?\n/)[0] ??
        ""
      ).slice(0, 300);
      return failedResult({
        ...identity,
        ...runtimeIdentity,
        reason: `gm2godot validate exited with code ${String(captured.exitCode)} and wrote no validation report: ${firstLine}`,
      });
    }
    return skippedResult({
      ...identity,
      ...runtimeIdentity,
      reason: `${reading.reason}; nothing about the generated resources was verified`,
    });
  }

  if (reading.status === "skipped") {
    return skippedResult({
      ...identity,
      ...runtimeIdentity,
      reason: reading.message,
    });
  }

  if (reading.status === "failed" || captured.exitCode !== 0) {
    return failedResult({
      ...identity,
      ...runtimeIdentity,
      reason: `gm2godot validate reported ${reading.status} (exit ${String(captured.exitCode)}): ${reading.message}`,
      artifacts: [
        logPath,
        join(deps.projectPath, GODOT_VALIDATION_REPORT_RELATIVE_PATH),
      ],
    });
  }

  if (probe.version === null) {
    return inconclusiveResult({
      ...identity,
      ...runtimeIdentity,
      reason: `gm2godot validate reported passed but no engine build string could be probed: ${probe.reason}`,
    });
  }

  if (deps.expectedGodot !== undefined && !probe.matchesExpected) {
    return inconclusiveResult({
      ...identity,
      ...runtimeIdentity,
      engineVersion: probe.version,
      reason: `gm2godot validate reported passed against an unexpected engine build: ${probe.reason}`,
    });
  }

  return passedResult({
    ...identity,
    command,
    engineVersion: probe.version,
    exitStatus: captured.exitCode,
    durationMs,
    logsPath: logPath,
    artifacts: [
      logPath,
      join(deps.projectPath, GODOT_VALIDATION_REPORT_RELATIVE_PATH),
    ],
    reason: `gm2godot validate reported passed (${reading.message})`,
  });
}

/**
 * Run both level B halves. The static half always runs; the converter-backed half is `skipped` with a
 * reason when no engine binary is configured.
 *
 * `deps.projectPath` must be a **candidate** copy, never the live `port/`: GM2Godot's `validate`
 * writes `gm2godot/godot_validation_report.json` (and headless Godot its import cache) inside the
 * project it is pointed at.
 */
export async function checkStructural(
  deps: StructuralDeps,
): Promise<readonly ValidationResult[]> {
  const staticResult = checkStructuralStatic({
    projectPath: deps.projectPath,
    inputRevision: deps.inputRevision,
    reportDir: deps.reportDir,
  });
  const gm2godotResult = await checkGm2GodotValidate(deps);
  return [staticResult, gm2godotResult];
}
