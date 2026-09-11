import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../util/json.ts";
import { buildSubprocessEnv } from "../sandbox/env.ts";
import { spawnCapture, stripAnsi } from "../util/proc.ts";
import { probeGodot } from "../adapters/godot/adapter.ts";
import type { GodotProbe } from "../adapters/godot/adapter.ts";
import { failedResult, inconclusiveResult, passedResult } from "./levels.ts";
import type { CheckLevel, ValidationResult } from "./levels.ts";

/**
 * Level C runtime verification: run the engine headlessly against a project and judge the outcome
 * from the exit status **and** the parsed output. An engine error line fails the check even when the
 * process exits 0, and a check can only be `passed` with a real command, a probed engine build string
 * and a numeric exit status.
 *
 * Every run is preceded by one idempotent `--import` pass (see {@link importGodotProject}) so a cold
 * project's missing import cache cannot masquerade as a runtime failure.
 */

/** Godot prints these at the start of a line; a warning is not a failure, an error is. */
export const ENGINE_ERROR_PATTERN = /^(ERROR|SCRIPT ERROR|SHADER ERROR)/;

export interface GodotVersionExpectation {
  readonly expectedVersion: string;
  readonly expectedVersionPrefix: string;
}

export interface GodotHeadlessRunDeps {
  readonly binary: string;
  readonly projectPath: string;
  /** `res://`-relative script, e.g. `tools/deep_trace.gd`. */
  readonly scriptPath: string;
  readonly timeoutSeconds: number;
  readonly logsDir: string;
  readonly checkId: string;
  readonly inputRevision: string;
  readonly level?: CheckLevel;
  readonly name?: string;
  readonly expectedGodot?: GodotVersionExpectation;
}

/** What the runtime observed, independent of the check verdict. */
export interface RunObservations {
  readonly stdout: string;
  readonly stderr: string;
  /** Engine build string exactly as probed; `null` when the probe produced none. */
  readonly engineBuild: string | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

/** A runtime check result that also carries the captured output, so level D can read the trace line. */
export interface GodotRunCheck extends ValidationResult {
  /** Always present on a runtime check; `null` when no process exit status was observed. */
  readonly exitStatus: number | null;
  readonly durationMs: number;
  readonly logsPath: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly engineBuild: string | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

/** First line of engine output that reports an error, or `null`. ANSI must already be stripped. */
export function firstEngineErrorLine(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (ENGINE_ERROR_PATTERN.test(line)) return line.length > 300 ? `${line.slice(0, 300)}…` : line;
  }
  return null;
}

export interface GodotImportDeps {
  readonly binary: string;
  readonly projectPath: string;
  readonly timeoutSeconds: number;
  readonly logsDir: string;
  /** The log is written as `<logsDir>/<checkId>.log`, so the caller can keep it distinct. */
  readonly checkId: string;
}

/** Result of the preparatory `--import` pass. A non-zero exit or error line is recorded, not hidden. */
export interface GodotImportOutcome {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly errorLine: string | null;
  readonly logPath: string;
  /** Non-null when the engine could not be spawned at all; `exitCode` is then `null`. */
  readonly spawnError: string | null;
}

/**
 * Run one `--import` pass so the project has Godot's own `.godot/` cache and `.import` files.
 *
 * A cold GM2Godot generation has no import cache, and a first run then reports
 * `No loader found for resource: res://…png` plus a `.tscn` parse error even though the script runs
 * and exits 0. Those lines are an artefact of the cache, not of the port's behaviour, so they are
 * cleared by an explicit import pass before any check judges the run's output. The cache only ever
 * lands inside the caller's project copy.
 */
export async function importGodotProject(deps: GodotImportDeps): Promise<GodotImportOutcome> {
  const argv = [deps.binary, "--headless", "--path", deps.projectPath, "--import"];
  let captured;
  try {
    captured = await spawnCapture({
      argv,
      cwd: process.cwd(),
      env: buildSubprocessEnv({}),
      timeoutSeconds: deps.timeoutSeconds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logPath = writeRunLog(deps, {
      argv,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: `could not run the import pass: ${message}`,
      durationMs: 0,
      timedOut: false,
      truncated: false,
    });
    return { argv, exitCode: null, durationMs: 0, timedOut: false, errorLine: null, logPath, spawnError: message };
  }
  const stdout = stripAnsi(captured.stdout);
  const stderr = stripAnsi(captured.stderr);
  const logPath = writeRunLog(deps, {
    argv,
    exitCode: captured.exitCode,
    signal: captured.signal,
    stdout,
    stderr,
    durationMs: captured.durationMs,
    timedOut: captured.timedOut,
    truncated: captured.truncated,
  });
  return {
    argv,
    exitCode: captured.exitCode,
    durationMs: captured.durationMs,
    timedOut: captured.timedOut,
    errorLine: firstEngineErrorLine(stdout) ?? firstEngineErrorLine(stderr),
    logPath,
    spawnError: null,
  };
}

function writeRunLog(
  deps: { readonly logsDir: string; readonly checkId: string },
  observed: {
    argv: readonly string[];
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    truncated: boolean;
  },
): string {
  const logPath = join(deps.logsDir, `${deps.checkId}.log`);
  ensureDir(deps.logsDir);
  const header = [
    `# command: ${observed.argv.join(" ")}`,
    `# exit: ${String(observed.exitCode)} signal: ${String(observed.signal)} timedOut: ${String(observed.timedOut)} truncated: ${String(observed.truncated)} durationMs: ${String(observed.durationMs)}`,
    "",
    "--- stdout ---",
    observed.stdout,
    "--- stderr ---",
    observed.stderr,
    "",
  ].join("\n");
  writeFileSync(logPath, header, "utf8");
  return logPath;
}

function withObservations(result: ValidationResult, observations: RunObservations): GodotRunCheck {
  return {
    ...result,
    ...observations,
    exitStatus: result.exitStatus ?? null,
    durationMs: result.durationMs ?? 0,
    logsPath: result.logsPath ?? "",
  };
}

/**
 * Import the project once, then run `godot --headless --path <projectPath> --script res://<scriptPath>`,
 * capture bounded output, persist the raw logs and return a runtime check. The caller owns copying the
 * project; this function writes only the logs and Godot's own `.godot/` cache inside `projectPath`.
 */
export async function runGodotHeadless(deps: GodotHeadlessRunDeps): Promise<GodotRunCheck> {
  const level = deps.level ?? "C";
  const name = deps.name ?? `godot headless run (${deps.checkId})`;
  const argv = [deps.binary, "--headless", "--path", deps.projectPath, "--script", `res://${deps.scriptPath}`];

  // A cold GM2Godot generation has no `.godot/` import cache, and the first script run then reports
  // `No loader found for resource: res://…png` plus a `.tscn` parse error while behaving correctly.
  // One idempotent import pass removes that artefact before anything judges the run's output.
  const importPass = await importGodotProject({
    binary: deps.binary,
    projectPath: deps.projectPath,
    timeoutSeconds: deps.timeoutSeconds,
    logsDir: deps.logsDir,
    checkId: `${deps.checkId}.import`,
  });
  if (importPass.spawnError !== null || importPass.exitCode !== 0 || importPass.errorLine !== null) {
    const reason =
      importPass.spawnError !== null
        ? `godot --import pass could not run: ${importPass.spawnError} (command: ${importPass.argv.join(" ")})`
        : importPass.exitCode !== 0
          ? `godot --import pass exited with code ${String(importPass.exitCode)}`
          : `godot --import pass reported an error line: ${String(importPass.errorLine)}`;
    return withObservations(
      failedResult({
        level,
        checkId: deps.checkId,
        name,
        inputRevision: deps.inputRevision,
        reason,
        exitStatus: importPass.exitCode,
        durationMs: importPass.durationMs,
        logsPath: importPass.logPath,
        artifacts: [importPass.logPath],
      }),
      { stdout: "", stderr: "", engineBuild: null, timedOut: importPass.timedOut, truncated: false },
    );
  }

  let captured;
  try {
    captured = await spawnCapture({
      argv,
      cwd: process.cwd(),
      env: buildSubprocessEnv({}),
      timeoutSeconds: deps.timeoutSeconds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logPath = writeRunLog(deps, {
      argv,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: `could not run the godot binary: ${message}`,
      durationMs: 0,
      timedOut: false,
      truncated: false,
    });
    return withObservations(
      failedResult({
        level,
        checkId: deps.checkId,
        name,
        inputRevision: deps.inputRevision,
        reason: `could not run the godot binary: ${message} (command: ${argv.join(" ")})`,
        logsPath: logPath,
        artifacts: [logPath, importPass.logPath],
      }),
      { stdout: "", stderr: "", engineBuild: null, timedOut: false, truncated: false },
    );
  }

  const exitCode = captured.exitCode;
  const stdout = stripAnsi(captured.stdout);
  const stderr = stripAnsi(captured.stderr);
  const logPath = writeRunLog(deps, {
    argv,
    exitCode,
    signal: captured.signal,
    stdout,
    stderr,
    durationMs: captured.durationMs,
    timedOut: captured.timedOut,
    truncated: captured.truncated,
  });

  const command = argv.join(" ");
  const engineProbe: GodotProbe = await probeGodot(
    deps.binary,
    deps.expectedGodot ?? { expectedVersion: "", expectedVersionPrefix: "" },
  );
  const observations: RunObservations = {
    stdout,
    stderr,
    engineBuild: engineProbe.version,
    timedOut: captured.timedOut,
    truncated: captured.truncated,
  };
  const errorLine = firstEngineErrorLine(stdout) ?? firstEngineErrorLine(stderr);

  if (errorLine !== null) {
    return withObservations(
      failedResult({
        level,
        checkId: deps.checkId,
        name,
        inputRevision: deps.inputRevision,
        reason: `engine reported an error line: ${errorLine}`,
        exitStatus: exitCode,
        logsPath: logPath,
        durationMs: captured.durationMs,
        command,
        ...(engineProbe.version === null ? {} : { engineVersion: engineProbe.version }),
        artifacts: [logPath, importPass.logPath],
      }),
      observations,
    );
  }

  if (captured.timedOut) {
    return withObservations(
      failedResult({
        level,
        checkId: deps.checkId,
        name,
        inputRevision: deps.inputRevision,
        reason: `engine run timed out after ${String(deps.timeoutSeconds)}s and was killed`,
        exitStatus: exitCode,
        logsPath: logPath,
        durationMs: captured.durationMs,
        command,
        ...(engineProbe.version === null ? {} : { engineVersion: engineProbe.version }),
        artifacts: [logPath, importPass.logPath],
      }),
      observations,
    );
  }

  if (exitCode !== 0) {
    return withObservations(
      failedResult({
        level,
        checkId: deps.checkId,
        name,
        inputRevision: deps.inputRevision,
        reason: `engine exited with code ${String(exitCode)} and printed no error line`,
        exitStatus: exitCode,
        logsPath: logPath,
        durationMs: captured.durationMs,
        command,
        ...(engineProbe.version === null ? {} : { engineVersion: engineProbe.version }),
        artifacts: [logPath, importPass.logPath],
      }),
      observations,
    );
  }

  if (engineProbe.version === null) {
    return withObservations(
      inconclusiveResult({
        level,
        checkId: deps.checkId,
        name,
        inputRevision: deps.inputRevision,
        reason: `engine exited 0 but no engine build string could be probed: ${engineProbe.reason}`,
        exitStatus: exitCode,
        logsPath: logPath,
        durationMs: captured.durationMs,
        command,
        artifacts: [logPath, importPass.logPath],
      }),
      observations,
    );
  }

  if (deps.expectedGodot !== undefined && !engineProbe.matchesExpected) {
    return withObservations(
      inconclusiveResult({
        level,
        checkId: deps.checkId,
        name,
        inputRevision: deps.inputRevision,
        reason: `engine build is not the expected one, so the run proves nothing: ${engineProbe.reason}`,
        exitStatus: exitCode,
        engineVersion: engineProbe.version,
        logsPath: logPath,
        durationMs: captured.durationMs,
        command,
        artifacts: [logPath, importPass.logPath],
      }),
      observations,
    );
  }

  return withObservations(
    passedResult({
      level,
      checkId: deps.checkId,
      name,
      inputRevision: deps.inputRevision,
      command,
      engineVersion: engineProbe.version,
      exitStatus: exitCode,
      durationMs: captured.durationMs,
      logsPath: logPath,
      artifacts: [logPath, importPass.logPath],
      reason: `engine exited 0 with no error line (${engineProbe.reason})`,
    }),
    observations,
  );
}
