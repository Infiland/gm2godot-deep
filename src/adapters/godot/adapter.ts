import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildSubprocessEnv } from "../../sandbox/env.ts";
import { DeepError } from "../../util/result.ts";
import { spawnCapture, stripAnsi } from "../../util/proc.ts";
import type { SpawnCaptureResult } from "../../util/proc.ts";
import { compareGodotVersion, tryParseGodotVersion } from "./version.ts";

/** Reason returned whenever no usable engine binary is configured; never a silent success. */
const NOT_FOUND_REASON = "godot binary not configured or not found";
const VERSION_PROBE_TIMEOUT_SECONDS = 30;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export interface GodotProbe {
  readonly path: string | null;
  readonly version: string | null;
  readonly matchesExpected: boolean;
  readonly reason: string;
}

export interface GodotRunSpec {
  readonly binary: string;
  readonly projectPath: string;
  readonly extraArgs?: readonly string[] | undefined;
  readonly timeoutSeconds: number;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface GodotRunResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly engineVersion: string | null;
  /** True when the deadline fired and the process group was killed; `exitCode` is then `null`. */
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First non-empty line of captured engine output, truncated so a reason stays readable. */
function firstLine(text: string): string {
  const index = text.indexOf("\n");
  const line = (index === -1 ? text : text.slice(0, index)).trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function missingProbe(detail: string | null): GodotProbe {
  return {
    path: null,
    version: null,
    matchesExpected: false,
    reason: detail === null ? NOT_FOUND_REASON : `${NOT_FOUND_REASON}: ${detail}`,
  };
}

/**
 * Probe the engine binary with `--version`. Absence is not an error here: doctor and the validation
 * levels need to turn it into `skipped`/`blocked` with a reason, never into `passed`. A binary that
 * cannot be executed at all (as opposed to printing something unexpected) also returns a reason
 * rather than throwing.
 */
export async function probeGodot(
  binary: string | null,
  expected: { readonly expectedVersion: string; readonly expectedVersionPrefix: string },
): Promise<GodotProbe> {
  if (binary === null || binary.trim().length === 0) return missingProbe(null);
  // A bare name is left to PATH lookup by the spawn; anything path-shaped must be a real executable.
  const candidate = binary.includes("/") ? resolve(binary) : binary;
  if (candidate.includes("/") && !isRunnableFile(candidate)) {
    return missingProbe(`${candidate} is not an executable file`);
  }
  let captured: SpawnCaptureResult;
  try {
    captured = await spawnCapture({
      argv: [candidate, "--version"],
      cwd: process.cwd(),
      env: buildSubprocessEnv({}),
      timeoutSeconds: VERSION_PROBE_TIMEOUT_SECONDS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    return missingProbe(error instanceof Error ? error.message : String(error));
  }
  if (captured.timedOut) {
    return {
      path: candidate,
      version: null,
      matchesExpected: false,
      reason: `godot --version timed out after ${VERSION_PROBE_TIMEOUT_SECONDS}s`,
    };
  }
  const version =
    tryParseGodotVersion(stripAnsi(captured.stdout)) ?? tryParseGodotVersion(stripAnsi(captured.stderr));
  if (version === null) {
    return {
      path: candidate,
      version: null,
      matchesExpected: false,
      reason: `godot --version printed no build string (exit ${String(captured.exitCode)}): ${firstLine(captured.stdout) || firstLine(captured.stderr) || "<no output>"}`,
    };
  }
  if (captured.exitCode !== 0) {
    return {
      path: candidate,
      version,
      matchesExpected: false,
      reason: `godot ${version} but --version exited with code ${String(captured.exitCode)}`,
    };
  }
  const comparison = compareGodotVersion(version, expected.expectedVersion, expected.expectedVersionPrefix);
  return { path: candidate, version, matchesExpected: comparison.matches, reason: comparison.reason };
}

function buildGodotArgv(spec: GodotRunSpec): string[] {
  const extra = [...(spec.extraArgs ?? [])];
  const argv = [spec.binary];
  if (!extra.includes("--headless")) argv.push("--headless");
  argv.push("--path", spec.projectPath);
  argv.push(...extra);
  return argv;
}

// `--version` is cheap, but a run must never pay for it twice: one probe per binary per process.
const engineVersionCache: Record<string, Promise<string | null> | undefined> = {};

async function probeEngineVersion(
  binary: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<string | null> {
  try {
    const captured = await spawnCapture({
      argv: [binary, "--version"],
      cwd,
      env,
      timeoutSeconds: VERSION_PROBE_TIMEOUT_SECONDS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    });
    if (captured.exitCode !== 0) return null;
    return tryParseGodotVersion(stripAnsi(captured.stdout)) ?? tryParseGodotVersion(stripAnsi(captured.stderr));
  } catch {
    // `null` is the explicit "engine version unavailable" marker; the run result still stands.
    return null;
  }
}

async function resolveEngineVersion(
  binary: string,
  stdout: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<string | null> {
  const fromOutput = tryParseGodotVersion(stdout);
  if (fromOutput !== null) return fromOutput;
  const cached = engineVersionCache[binary];
  if (cached !== undefined) return cached;
  const pending = probeEngineVersion(binary, env, cwd);
  engineVersionCache[binary] = pending;
  return pending;
}

/**
 * Run the engine against a generated project. Always headless unless the caller asked for
 * `--headless` itself. A binary that cannot be spawned is a configuration failure and throws; an
 * engine that starts and fails (or is killed at the deadline) is a recorded result.
 */
export async function runGodot(spec: GodotRunSpec): Promise<GodotRunResult> {
  const argv = buildGodotArgv(spec);
  const env = buildSubprocessEnv({ ...(spec.env ?? {}) });
  const cwd = spec.cwd ?? process.cwd();
  let captured: SpawnCaptureResult;
  try {
    captured = await spawnCapture({ argv, cwd, env, timeoutSeconds: spec.timeoutSeconds });
  } catch (error) {
    throw new DeepError(
      "GM2DEEP-GODOT-SPAWN-FAILED",
      `could not run the Godot binary: ${error instanceof Error ? error.message : String(error)}`,
      { binary: spec.binary, argv },
    );
  }
  const stdout = stripAnsi(captured.stdout);
  const stderr = stripAnsi(captured.stderr);
  return {
    argv,
    exitCode: captured.exitCode,
    signal: captured.signal,
    stdout,
    stderr,
    durationMs: captured.durationMs,
    engineVersion: await resolveEngineVersion(spec.binary, stdout, env, cwd),
    timedOut: captured.timedOut,
    truncated: captured.truncated,
  };
}
