/**
 * Subprocess environments are built from an explicit allowlist. The host's `process.env` is never
 * inherited wholesale, and anything that looks like a provider credential is dropped even when a
 * caller passes it explicitly, so model keys cannot reach a sandboxed tool or an agent-authored
 * subprocess.
 */

/** Keys that may never reach a subprocess: model/provider credentials stay in the host process. */
export const MODEL_CREDENTIAL_PATTERN = /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** Environment keys inherited from the host process, when set. */
export const SUBPROCESS_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];

/** Keys that exist only on Windows and are required for a child process to start there. */
const WINDOWS_ENV_ALLOWLIST: readonly string[] = ["SYSTEMROOT"];

/**
 * Build the complete environment for a child process: the allowlisted host keys plus caller
 * overrides, minus anything matching {@link MODEL_CREDENTIAL_PATTERN}. Keys whose value is
 * `undefined` are omitted entirely (never serialized as the string "undefined").
 */
export function buildSubprocessEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const hostKeys =
    process.platform === "win32"
      ? [...SUBPROCESS_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]
      : SUBPROCESS_ENV_ALLOWLIST;
  for (const key of hostKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (MODEL_CREDENTIAL_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}
