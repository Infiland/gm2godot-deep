/**
 * Docker backend. Mounts are identity-mapped (`-v <host>:<host>`) so a task's absolute paths mean
 * the same thing inside and outside the container; the caller's `cwd` is used verbatim.
 *
 * The container receives an explicit environment: the docker CLI itself runs with the host
 * allowlist (it needs `PATH`, `HOME`, `DOCKER_HOST`-free defaults), while `spec.env` is forwarded
 * with `-e` because containers do not inherit the host's environment.
 */

import type { Config } from "../config/schema.ts";
import { buildSubprocessEnv, MODEL_CREDENTIAL_PATTERN } from "./env.ts";
import {
  assertSandboxSpec,
  runSandboxCapture,
  type SandboxBackend,
  type SandboxSpec,
  type SandboxResult,
} from "./backend.ts";
import { spawnCapture } from "../util/proc.ts";

/** True when the docker daemon answers `docker info`. */
export async function probeDockerDaemon(): Promise<boolean> {
  try {
    const result = await spawnCapture({
      argv: ["docker", "info"],
      cwd: process.cwd(),
      env: buildSubprocessEnv(),
      timeoutSeconds: 30,
      maxOutputBytes: 64 * 1024,
    });
    return result.exitCode === 0;
  } catch {
    // The probe *is* the availability question: a failed spawn (CLI absent) means "unavailable".
    return false;
  }
}

/** Build the full `docker run` argv. Exported so `doctor` and the report can show the exact command. */
export function buildDockerRunArgv(spec: SandboxSpec, sandbox: Config["sandbox"]): string[] {
  const argv = [
    "docker",
    "run",
    "--rm",
    "--network",
    spec.networkAllowed ? "bridge" : "none",
    "--cpus",
    String(sandbox.cpus),
    "--memory",
    `${sandbox.memoryMb}m`,
  ];
  for (const mount of spec.mounts) {
    argv.push("-v", `${mount.hostPath}:${mount.hostPath}:${mount.mode}`);
  }
  for (const [key, value] of Object.entries(spec.env)) {
    if (MODEL_CREDENTIAL_PATTERN.test(key)) continue;
    argv.push("-e", `${key}=${value}`);
  }
  argv.push("-w", spec.cwd, sandbox.dockerImage, ...spec.argv);
  return argv;
}

async function runInContainer(spec: SandboxSpec, sandbox: Config["sandbox"]): Promise<SandboxResult> {
  assertSandboxSpec(spec);
  return runSandboxCapture("docker", spec, buildDockerRunArgv(spec, sandbox), buildSubprocessEnv());
}

export function createDockerBackend(sandbox: Config["sandbox"]): SandboxBackend {
  return {
    id: "docker",
    available: probeDockerDaemon,
    run: (spec) => runInContainer(spec, sandbox),
  };
}
