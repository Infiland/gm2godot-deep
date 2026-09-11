import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DeepError } from "../util/result.ts";
import { writeJsonAtomic } from "../util/json.ts";
import { CONFIG_FILENAME, ConfigSchema, type AgentRuntimeId, type Config } from "./schema.ts";

export interface ConfigOverrides {
  readonly runtime?: AgentRuntimeId;
  readonly gm2godotCheckout?: string;
  readonly gm2godotPython?: string;
  readonly godotBinary?: string;
}

export function configPath(workspaceDir: string): string {
  return join(workspaceDir, CONFIG_FILENAME);
}

/** Validate a parsed config object; every validation failure names the offending path. */
export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new DeepError("GM2DEEP-CONFIG-INVALID", "configuration does not satisfy the schema", {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

export function applyOverrides(config: Config, overrides: ConfigOverrides): Config {
  return {
    ...config,
    gm2godot: {
      ...config.gm2godot,
      checkout: overrides.gm2godotCheckout ?? config.gm2godot.checkout,
      python: overrides.gm2godotPython ?? config.gm2godot.python,
    },
    godot: { ...config.godot, binary: overrides.godotBinary ?? config.godot.binary },
    agent: { ...config.agent, runtime: overrides.runtime ?? config.agent.runtime },
  };
}

export function loadConfig(workspaceDir: string, overrides: ConfigOverrides = {}): Config {
  const path = configPath(workspaceDir);
  if (!existsSync(path)) {
    throw new DeepError("GM2DEEP-CONFIG-MISSING", `no configuration at ${path}; run \`deep-convert init\` first`, {
      path,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DeepError("GM2DEEP-CONFIG-INVALID", `${path} is not valid JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return applyOverrides(parseConfig(raw), overrides);
}

export function writeConfig(workspaceDir: string, config: Config): string {
  const path = configPath(workspaceDir);
  writeJsonAtomic(path, config);
  return path;
}
