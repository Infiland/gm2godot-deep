/**
 * Backend selection. Isolation fails closed: when nothing usable is available this throws
 * {@link SandboxUnavailableError} rather than running the command unsandboxed. `unsafe-local` is
 * never reached by `auto` — it requires an explicit request plus the policy opt-in.
 */

import type { Config } from "../config/schema.ts";
import { SandboxUnavailableError, type SandboxBackend } from "./backend.ts";
import { createDockerBackend, probeDockerDaemon } from "./docker.ts";
import { createSandboxExecBackend, probeSandboxExec } from "./sandboxExec.ts";
import { createUnsafeLocalBackend } from "./unsafeLocal.ts";

export interface SandboxSelectionDeps {
  /** Availability probe for the docker daemon; defaults to `docker info`. */
  readonly probeDocker?: () => Promise<boolean>;
  /** Availability probe for `/usr/bin/sandbox-exec`; defaults to its own allow-everything run. */
  readonly probeSandboxExec?: () => Promise<boolean>;
}

/** Resolve the backend named by the config, probing the machine only when needed. */
export async function selectSandboxBackend(
  config: Config,
  deps: SandboxSelectionDeps = {},
): Promise<SandboxBackend> {
  const probeDocker = deps.probeDocker ?? probeDockerDaemon;
  const probeSandboxExecFn = deps.probeSandboxExec ?? probeSandboxExec;
  const requested = config.sandbox.backend;
  const context = {
    requested,
    platform: process.platform,
    dockerImage: config.sandbox.dockerImage,
    allowUnsafeLocal: config.policy.allowUnsafeLocal,
  };

  if (requested === "unsafe-local") {
    return createUnsafeLocalBackend({
      backend: requested,
      allowUnsafeLocal: config.policy.allowUnsafeLocal,
    });
  }

  const dockerUsable = await probeDocker();
  if (requested === "docker") {
    if (!dockerUsable) {
      throw new SandboxUnavailableError("docker backend requested but `docker info` failed", context);
    }
    return createDockerBackend(config.sandbox);
  }

  // `sandbox-exec` only exists on macOS; on other platforms the probe is not attempted at all.
  const sandboxExecUsable = process.platform === "darwin" ? await probeSandboxExecFn() : false;
  if (requested === "sandbox-exec") {
    if (!sandboxExecUsable) {
      throw new SandboxUnavailableError(
        "sandbox-exec backend requested but /usr/bin/sandbox-exec is unavailable on this host",
        context,
      );
    }
    return createSandboxExecBackend();
  }

  if (dockerUsable) return createDockerBackend(config.sandbox);
  if (sandboxExecUsable) return createSandboxExecBackend();

  throw new SandboxUnavailableError(
    "no usable sandbox backend: docker daemon unavailable and sandbox-exec unavailable",
    { ...context, dockerUsable, sandboxExecUsable },
  );
}
