import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const SYSTEM_ENV = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "USER",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;
export interface OpenCodeIsolation {
  cwd: string;
  password: string;
  config: unknown;
  provider: string | null;
  freeOnly: boolean;
  apiKey?: string;
}
/** Keep provider authentication deliberately scoped; never inherit global plugins, MCPs, helpers, or model overrides. */
export function isolatedOpenCodeEnvironment(
  options: OpenCodeIsolation,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SYSTEM_ENV)
    if (inherited[key] !== undefined) env[key] = inherited[key];
  Object.assign(env, {
    XDG_CONFIG_HOME: join(options.cwd, "config"),
    XDG_DATA_HOME: join(options.cwd, "data"),
    XDG_CACHE_HOME: join(options.cwd, "cache"),
    XDG_STATE_HOME: join(options.cwd, "state"),
    OPENCODE_CONFIG_DIR: join(options.cwd, "config", "opencode"),
    OPENCODE_SERVER_PASSWORD: options.password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  });
  // No key is needed for Zen's public free models. Paid mode copies only the selected provider's auth.
  if (!options.freeOnly && options.provider) {
    let auth: unknown = options.apiKey
      ? { type: "api", key: options.apiKey }
      : undefined;
    if (!auth) {
      const source = join(
        inherited["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
        "opencode",
        "auth.json",
      );
      if (existsSync(source)) {
        const entries = JSON.parse(readFileSync(source, "utf8")) as Record<
          string,
          unknown
        >;
        auth = entries[options.provider];
      }
    }
    if (auth && typeof auth === "object") {
      const directory = join(options.cwd, "data", "opencode");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(directory, "auth.json"),
        JSON.stringify({ [options.provider]: auth }),
        { mode: 0o600 },
      );
    }
  }
  return env;
}
