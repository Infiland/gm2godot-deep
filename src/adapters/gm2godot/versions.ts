import { DeepError } from "../../util/result.ts";

/** GM2Godot releases this orchestrator has been verified against. */
export const SUPPORTED_GM2GODOT_VERSIONS: readonly string[] = ["0.7.74"];

export const SUPPORTED_MANIFEST_FORMAT_VERSION = 2;
export const SUPPORTED_ATTEMPT_FORMAT_VERSION = 1;
export const SUPPORTED_GENERATION_INVENTORY_FORMAT_VERSION = 1;
export const SUPPORTED_ARCHITECTURE_POLICY_FORMAT_VERSION = 1;
export const SUPPORTED_SOURCE_MAP_VERSION = 1;

export const UPSTREAM_SCHEMA_ERROR = "GM2DEEP-UPSTREAM-UNSUPPORTED-SCHEMA";

export class UnsupportedUpstreamSchemaError extends DeepError {
  constructor(what: string, observed: unknown, supported: readonly (string | number)[]) {
    super(UPSTREAM_SCHEMA_ERROR, `${what} version ${String(observed)} is not supported`, {
      what,
      observed,
      supported,
    });
    this.name = "UnsupportedUpstreamSchemaError";
  }
}

/**
 * Called on every upstream JSON artifact **before any field is read**, so a newer GM2Godot can never be
 * silently interpreted with older assumptions.
 */
export function assertSupportedFormatVersion(
  what: string,
  observed: unknown,
  supported: number,
): asserts observed is number {
  if (observed !== supported) throw new UnsupportedUpstreamSchemaError(what, observed, [supported]);
}

export function assertSupportedToolVersion(
  what: string,
  observed: string,
  supported: readonly string[],
): void {
  if (!supported.includes(observed)) throw new UnsupportedUpstreamSchemaError(what, observed, supported);
}
