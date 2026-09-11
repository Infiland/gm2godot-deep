/**
 * The sandbox seam: every isolation-requiring operation describes *what* to run (a
 * {@link SandboxSpec}) and the selected backend decides *how* to isolate it. Nothing above this
 * layer knows whether the process ran under `sandbox-exec`, docker, or unsafely in place.
 *
 * All three backends share one child-process runner (`src/util/proc.ts`), so byte capping, the
 * wall-clock deadline, process-group kill and duration measurement behave identically everywhere.
 */

import type { SandboxBackendId } from "../config/schema.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, spawnCapture } from "../util/proc.ts";
import { DeepError } from "../util/result.ts";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Re-exported so callers constructing a {@link SandboxSpec} use the same cap as the runner. */
export { DEFAULT_MAX_OUTPUT_BYTES as MAX_OUTPUT_BYTES_DEFAULT } from "../util/proc.ts";

export interface SandboxMount {
  /** Absolute host directory, mapped to the same absolute path inside the sandbox. */
  readonly hostPath: string;
  readonly mode: "ro" | "rw";
}

export interface SandboxSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly mounts: readonly SandboxMount[];
  readonly env: Readonly<Record<string, string>>;
  readonly networkAllowed: boolean;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
}

export interface SandboxResult {
  readonly backendId: SandboxBackendId;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  available(): Promise<boolean>;
  run(spec: SandboxSpec): Promise<SandboxResult>;
}

/**
 * Raised when no isolation mechanism can be selected. Selection fails closed: an unavailable
 * backend is never silently replaced by running in place.
 */
export class SandboxUnavailableError extends DeepError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("GM2DEEP-SANDBOX-UNAVAILABLE", message, detail);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * Reject malformed specs before spawning. Mounts and `cwd` are identity-mapped, so they must be
 * absolute host paths that exist; a silently relative mount would be read as a docker volume name
 * (or as a non-existent path under `sandbox-exec`) and quietly sandbox the wrong tree.
 */
export function assertSandboxSpec(spec: SandboxSpec): void {
  if (spec.argv.length === 0) {
    throw new DeepError("GM2DEEP-SANDBOX-INVALID-SPEC", "sandbox spec has an empty argv");
  }
  if (!isAbsolute(spec.cwd) || !existsSync(spec.cwd)) {
    throw new DeepError("GM2DEEP-SANDBOX-INVALID-SPEC", `sandbox cwd is not an existing absolute path: ${spec.cwd}`, {
      cwd: spec.cwd,
    });
  }
  for (const mount of spec.mounts) {
    if (!isAbsolute(mount.hostPath) || !existsSync(mount.hostPath)) {
      throw new DeepError(
        "GM2DEEP-SANDBOX-INVALID-SPEC",
        `sandbox mount is not an existing absolute path: ${mount.hostPath}`,
        { hostPath: mount.hostPath, mode: mount.mode },
      );
    }
  }
}

/**
 * Run `argv` through the shared capture runner and label the result with the backend that produced
 * it. `argv` defaults to the spec's command; `env` defaults to the spec's environment (docker
 * replaces it with the host-side allowlist and forwards the spec's environment into the container
 * explicitly).
 */
export async function runSandboxCapture(
  backendId: SandboxBackendId,
  spec: SandboxSpec,
  argv: readonly string[] = spec.argv,
  env: Readonly<Record<string, string>> = spec.env,
): Promise<SandboxResult> {
  const result = await spawnCapture({
    argv,
    cwd: spec.cwd,
    env,
    timeoutSeconds: spec.timeoutSeconds,
    maxOutputBytes: spec.maxOutputBytes,
  });
  return {
    backendId,
    argv: result.argv,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    durationMs: result.durationMs,
  };
}
