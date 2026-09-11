import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { DeepError } from "../util/result.ts";
import type { Config } from "./schema.ts";

export interface ExecutableProbe {
  readonly path: string;
  readonly source: string;
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

/** PATH search for a bare command name; returns the first runnable match. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes("/")) return isRunnableFile(resolve(command)) ? resolve(command) : null;
  for (const directory of (env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, command);
    if (isRunnableFile(candidate)) return candidate;
  }
  return null;
}

const GODOT_MACOS_BUNDLE = "/Applications/Godot.app/Contents/MacOS/Godot";

/**
 * Resolve the interpreter that runs GM2Godot. Order: explicit config → `GM2GODOT_PYTHON` →
 * `<checkout>/.venv/bin/python` → `python3.12` → `python3`. The plan names the exact order because a
 * GM2Godot checkout usually carries its own virtualenv.
 */
export function resolvePython(config: Config, env: NodeJS.ProcessEnv = process.env): ExecutableProbe {
  const tried: string[] = [];
  const candidates: { path: string; source: string }[] = [];
  if (config.gm2godot.python) candidates.push({ path: config.gm2godot.python, source: "config" });
  const fromEnv = env["GM2GODOT_PYTHON"];
  if (fromEnv) candidates.push({ path: fromEnv, source: "env:GM2GODOT_PYTHON" });
  candidates.push({ path: join(config.gm2godot.checkout, ".venv", "bin", "python"), source: "checkout .venv" });

  for (const candidate of candidates) {
    const absolute = resolve(candidate.path);
    tried.push(`${candidate.source}: ${absolute}`);
    if (isRunnableFile(absolute)) return { path: absolute, source: candidate.source };
  }
  for (const name of ["python3.12", "python3"]) {
    tried.push(`PATH: ${name}`);
    const found = findOnPath(name, env);
    if (found) return { path: found, source: `PATH (${name})` };
  }
  throw new DeepError("GM2DEEP-PYTHON-NOT-FOUND", "no Python interpreter for GM2Godot was found", { tried });
}

/**
 * Resolve the Godot binary. A missing binary is not fatal here: engine-backed checks become
 * `skipped` with a reason, never `passed`.
 */
export function resolveGodotBinary(config: Config, env: NodeJS.ProcessEnv = process.env): ExecutableProbe | null {
  if (config.godot.binary) {
    const absolute = resolve(config.godot.binary);
    if (isRunnableFile(absolute)) return { path: absolute, source: "config" };
  }
  const fromEnv = env["GODOT_BIN"];
  if (fromEnv) {
    const absolute = resolve(fromEnv);
    if (isRunnableFile(absolute)) return { path: absolute, source: "env:GODOT_BIN" };
  }
  const onPath = findOnPath("godot", env);
  if (onPath) return { path: onPath, source: "PATH (godot)" };
  if (isRunnableFile(GODOT_MACOS_BUNDLE)) return { path: GODOT_MACOS_BUNDLE, source: "macOS bundle" };
  return null;
}
