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

function writeRunLog(
  deps: GodotHeadlessRunDeps,
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
 * Run `godot --headless --path <projectPath> --script res://<scriptPath>`, capture bounded output,
 * persist the raw log and return a runtime check. The caller owns copying the project; this function
 * writes only the log file.
 */
export async function runGodotHeadless(deps: GodotHeadlessRunDeps): Promise<GodotRunCheck> {
  const level = deps.level ?? "C";
  const name = deps.name ?? `godot headless run (${deps.checkId})`;
  const argv = [deps.binary, "--headless", "--path", deps.projectPath, "--script", `res://${deps.scriptPath}`];

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
        artifacts: [logPath],
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
        artifacts: [logPath],
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
        artifacts: [logPath],
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
        artifacts: [logPath],
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
        artifacts: [logPath],
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
        artifacts: [logPath],
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
      artifacts: [logPath],
      reason: `engine exited 0 with no error line (${engineProbe.reason})`,
    }),
    observations,
  );
}
