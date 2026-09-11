import { DeepError } from "../../util/result.ts";

/**
 * Shape of the build string Godot prints for `--version`, e.g. `4.7.2.stable.official.ed1daf0bf`.
 * Anchored on purpose: the banner a normal run prints (`Godot Engine v4.7.2… - https://godotengine.org`)
 * is neither a version line nor accepted here.
 */
export const GODOT_VERSION_PATTERN = /^\d+\.\d+(\.\d+)?[.\w-]*$/;

/** First trimmed line of `output` that is exactly a Godot build string, or `null`. */
export function tryParseGodotVersion(output: string): string | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (GODOT_VERSION_PATTERN.test(line)) return line;
  }
  return null;
}

export function parseGodotVersion(output: string): string {
  const version = tryParseGodotVersion(output);
  if (version === null) {
    throw new DeepError("GM2DEEP-GODOT-VERSION-UNPARSEABLE", "godot --version output contained no build string", {
      output: output.slice(0, 400),
    });
  }
  return version;
}

/**
 * Compare an observed build string with the configured expectation. The plan pins the *exact* engine
 * build (`4.7.2.stable.official.ed1daf0bf`): a different build of the same release is reported as a
 * mismatch — with a reason that says the release prefix was right — so engine-backed checks can be
 * recorded as blocked rather than passed against an unverified engine.
 */
export function compareGodotVersion(
  version: string,
  expectedVersion: string,
  expectedVersionPrefix: string,
): { matches: boolean; reason: string } {
  if (expectedVersion.length > 0 && version === expectedVersion) {
    return { matches: true, reason: `godot ${version} is the expected build` };
  }
  const prefix = expectedVersionPrefix.trim();
  if (prefix.length > 0 && (version === prefix || version.startsWith(`${prefix}.`) || version.startsWith(`${prefix}-`))) {
    return {
      matches: false,
      reason: `godot ${version} is a ${prefix}-family build but not the expected build ${expectedVersion}`,
    };
  }
  return {
    matches: false,
    reason: `godot ${version} does not match expected ${expectedVersion} (expected release prefix ${expectedVersionPrefix})`,
  };
}
