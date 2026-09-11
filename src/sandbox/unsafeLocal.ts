/**
 * Unsafe local backend: no isolation at all, direct spawn in the host process's context.
 *
 * It exists only because some checks (for example a toolchain that cannot run under
 * `sandbox-exec` or docker on this machine) would otherwise be impossible to execute. Construction
 * requires two independent opt-ins — `sandbox.backend === "unsafe-local"` and
 * `policy.allowUnsafeLocal === true` — and every result it produces carries
 * `backendId: "unsafe-local"` so the report can render an unmissable `UNSAFE LOCAL MODE` banner
 * listing each check that used it.
 */

import type { Config } from "../config/schema.ts";
import {
  assertSandboxSpec,
  runSandboxCapture,
  SandboxUnavailableError,
  type SandboxBackend,
  type SandboxSpec,
  type SandboxResult,
} from "./backend.ts";

/**
 * Construct the unsafe backend. `backend` must be the explicit `"unsafe-local"` request (an `auto`
 * selection is never allowed to land here) and `allowUnsafeLocal` must be true.
 */
export function createUnsafeLocalBackend(gate: {
  readonly backend: Config["sandbox"]["backend"];
  readonly allowUnsafeLocal: boolean;
}): SandboxBackend {
  if (gate.backend !== "unsafe-local" || gate.allowUnsafeLocal !== true) {
    throw new SandboxUnavailableError(
      "unsafe-local mode requires sandbox.backend=\"unsafe-local\" and policy.allowUnsafeLocal=true",
      { backend: gate.backend, allowUnsafeLocal: gate.allowUnsafeLocal },
    );
  }
  return {
    id: "unsafe-local",
    available: async () => true,
    run: async (spec: SandboxSpec): Promise<SandboxResult> => {
      assertSandboxSpec(spec);
      return runSandboxCapture("unsafe-local", spec);
    },
  };
}
