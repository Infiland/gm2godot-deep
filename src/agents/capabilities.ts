import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { discoverCodex } from "./external/codexCapabilities.ts";
import type { CodexInstallationSource } from "./external/codexExecutable.ts";
import { runProcess } from "./external/process.ts";
import { OpenCodeClient } from "./external/opencode.ts";
import { isVerifiedFree } from "../models/freePolicy.ts";
import { verifyZenCatalog } from "../models/zenCatalog.ts";
export interface ProviderCapability {
  runtime: string;
  installed: boolean;
  authenticated: boolean | null;
  executable?: string;
  installationSource?: CodexInstallationSource;
  authMode?: "chatgpt" | "apiKey" | "other" | null;
  discoveryStatus?: "ready" | "login-required" | "unavailable";
  models: {
    id: string;
    name: string;
    provider?: string;
    providerName?: string;
    authenticated?: boolean | null;
    freeEligible?: boolean;
    available?: boolean;
    toolcall?: boolean;
  }[];
  reason?: string;
}
/** Discovery performs no inference and returns no credentials or raw agent output. */
export async function discoverAgent(options: {
  runtime: "codex" | "claude" | "opencode";
  executable?: string;
  endpoint?: string;
  password?: string;
  provider?: string | null;
  freeOnly?: boolean;
  signal: AbortSignal;
}): Promise<ProviderCapability> {
  options.signal.throwIfAborted();
  if (options.runtime === "codex") return discoverCodex(options);
  const cwd = mkdtempSync(join(tmpdir(), "gm2deep-discover-"));
  const executable = options.executable ?? options.runtime;
  const base = { runtime: options.runtime, installed: true };
  try {
    if (options.runtime === "claude") {
      const status = JSON.parse(
        await runProcess(
          executable,
          ["auth", "status", "--json"],
          cwd,
          "",
          options.signal,
          [0, 1],
        ),
      ) as { loggedIn?: boolean };
      return {
        ...base,
        authenticated: status.loggedIn ?? null,
        models: [],
        reason:
          "Claude Code supports model aliases or an exact model id; its CLI does not expose a model discovery endpoint.",
      };
    }
    const client = new OpenCodeClient({
      executable,
      cwd,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.freeOnly !== undefined ? { freeOnly: options.freeOnly } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.password ? { password: options.password } : {}),
    });
    try {
      const models = await client.catalog(options.signal);
      const authenticated = knownOpenCodeProviders();
      const verifiedFree = new Set(
        (await verifyZenCatalog(models.filter(isVerifiedFree), options.signal).catch(() => []))
          .map((model) => `${model.provider}/${model.id}`),
      );
      return {
        ...base,
        authenticated: null,
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          providerName: m.providerName ?? m.provider,
          authenticated: m.connected === true || authenticated.has(m.provider) || verifiedFree.has(`${m.provider}/${m.id}`)
            ? true : m.provider === "opencode" ? null : false,
          freeEligible: verifiedFree.has(`${m.provider}/${m.id}`),
          available: m.status !== "deprecated" && m.toolcall,
          toolcall: m.toolcall,
        })),
        reason:
          "Provider sign-in is detected locally; model availability and limits are checked again when tasks run. Discovery does not send prompts.",
      };
    } finally {
      await client.close();
    }
  } catch {
    return {
      runtime: options.runtime,
      installed: false,
      authenticated: null,
      models: [],
      reason:
        "Agent discovery failed; check installation, authentication and supported version.",
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Return provider identities only; do not expose credentials or copy unrelated auth into discovery. */
function knownOpenCodeProviders(): Set<string> {
  try {
    const path = join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "opencode", "auth.json");
    const entries: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return new Set();
    return new Set(Object.entries(entries).filter(([, value]) => {
      if (!value || typeof value !== "object") return false;
      const auth = value as Record<string, unknown>;
      return (auth["type"] === "api" && typeof auth["key"] === "string" && auth["key"].length > 0)
        || (auth["type"] === "oauth" && typeof auth["refresh"] === "string" && auth["refresh"].length > 0);
    }).map(([provider]) => provider));
  } catch {
    return new Set();
  }
}

export async function discoverPi(
  providerId: string,
  credentials: Readonly<Record<string, string>>,
): Promise<ProviderCapability> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId))
    return {
      runtime: "pi",
      installed: true,
      authenticated: false,
      models: [],
      reason: "Select a supported API provider",
    };
  try {
    const { createModels } = await import("@earendil-works/pi-ai");
    const module = (await import(
      `@earendil-works/pi-ai/providers/${providerId}`
    )) as Record<string, unknown>;
    const factory = Object.entries(module).find(
      ([name, value]) =>
        name.endsWith("Provider") && typeof value === "function",
    )?.[1];
    if (typeof factory !== "function") throw new Error("No provider factory");
    const provider = factory() as import("@earendil-works/pi-ai").Provider;
    const models = createModels();
    models.setProvider(provider);
    const auth =
      credentials[providerId] !== undefined ||
      (await models.getAuth(providerId)) !== undefined;
    return {
      runtime: "pi",
      installed: true,
      authenticated: auth,
      models: models
        .getModels(providerId)
        .map((m) => ({ id: m.id, name: m.name, provider: providerId })),
    };
  } catch {
    return {
      runtime: "pi",
      installed: true,
      authenticated: false,
      models: [],
      reason: "Provider is unavailable or could not resolve credentials",
    };
  }
}
