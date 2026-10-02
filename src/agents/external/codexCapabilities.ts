import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ProviderCapability } from "../capabilities.ts";
import { CodexConnection, normalizeCodexProvider } from "./codex.ts";
import { resolveCodexExecutable, type ResolvedCodex } from "./codexExecutable.ts";

const AccountSchema = z.object({
  account: z.object({ type: z.string().min(1) }).nullable(),
  requiresOpenaiAuth: z.boolean().optional(),
});
const ModelPageSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    model: z.string().min(1).optional(),
    displayName: z.string().optional(),
  })).max(1000),
  nextCursor: z.string().min(1).nullable().optional(),
});

/** Ask Codex itself about its account; never open or copy its credential cache. */
export async function discoverCodex(options: {
  executable?: string;
  provider?: string | null;
  signal: AbortSignal;
}): Promise<ProviderCapability> {
  options.signal.throwIfAborted();
  let resolved: ResolvedCodex | null;
  try {
    resolved = resolveCodexExecutable(options.executable);
  } catch {
    return {
      runtime: "codex", installed: false, authenticated: null, authMode: null,
      models: [], discoveryStatus: "unavailable",
      reason: "The selected Codex executable is unavailable. Select a valid executable path or clear it to detect Codex automatically.",
    };
  }
  if (!resolved) return {
    runtime: "codex", installed: false, authenticated: null, authMode: null,
    models: [], discoveryStatus: "unavailable",
    reason: "Codex was not found. Install Codex CLI or select the executable bundled with the desktop app.",
  };
  const metadata = {
    runtime: "codex", installed: true, executable: resolved.executable,
    installationSource: resolved.installationSource,
  };
  const cwd = mkdtempSync(join(tmpdir(), "gm2deep-discover-"));
  let client: CodexConnection | null = null;
  let authenticated: boolean | null = null;
  let authMode: ProviderCapability["authMode"] = null;
  const abort = (): void => { void client?.close(); };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    options.signal.throwIfAborted();
    client = new CodexConnection(resolved, cwd, options.provider);
    options.signal.throwIfAborted();
    await client.call("initialize", {
      clientInfo: { name: "gm2godot-deep", version: "1" },
    });
    client.notify("initialized");
    const account = AccountSchema.parse(await client.call("account/read", { refreshToken: false }));
    // Cached OpenAI account info can coexist with a configured provider that
    // does not use it. Do not label that provider as using ChatGPT/API auth.
    authenticated = account.requiresOpenaiAuth === false ? null
      : account.account !== null ? true
      : account.requiresOpenaiAuth === true ? false : null;
    authMode = account.account === null ? null
      : account.account.type === "chatgpt"
        ? account.requiresOpenaiAuth === false ? null : "chatgpt"
        : account.account.type === "apiKey"
          ? account.requiresOpenaiAuth === false ? null : "apiKey" : "other";
    const provider = normalizeCodexProvider(options.provider) ?? "codex";
    const models: ProviderCapability["models"] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      options.signal.throwIfAborted();
      const listed = ModelPageSchema.parse(await client.call("model/list", {
        limit: 100, ...(cursor ? { cursor } : {}),
      }));
      for (const model of listed.data) {
        const id = model.model ?? model.id;
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 10000) throw new Error("Codex model catalog exceeded its limit");
        models.push({
          id, name: model.displayName || id, provider,
          providerName: provider === "codex" ? "Codex configured provider" : provider,
          authenticated,
        });
      }
      if (!listed.nextCursor) {
        const loginRequired = authenticated === false;
        const ready = authenticated === true || account.requiresOpenaiAuth === false;
        return {
          ...metadata, authenticated, authMode, models,
          discoveryStatus: loginRequired ? "login-required" : ready ? "ready" : "unavailable",
          reason: loginRequired
            ? "Codex is installed but sign-in is required. Run codex login with this installation, then refresh models."
            : authMode === "chatgpt"
              ? "Existing ChatGPT sign-in is ready. Codex manages credentials and account usage limits."
              : authMode === "apiKey"
                ? "Existing Codex API key sign-in is ready. Usage follows that API account."
                : authenticated === true
                  ? "Existing Codex authentication is ready. The configured provider is retained."
                  : ready
                    ? "The configured Codex provider does not require OpenAI sign-in. Availability is checked when tasks run."
                    : "Codex is installed, but sign-in status is unavailable. Run codex login status with this installation and refresh models.",
        };
      }
      if (cursors.has(listed.nextCursor)) throw new Error("Codex repeated a model cursor");
      cursors.add(listed.nextCursor);
      cursor = listed.nextCursor;
    }
    throw new Error("Codex model discovery exceeded its page limit");
  } catch {
    return {
      ...metadata, authenticated, authMode, models: [], discoveryStatus: "unavailable",
      reason: options.signal.aborted
        ? "Codex discovery was interrupted. Refresh models to retry."
        : "Codex is installed, but account/model discovery failed. Check this installation with codex login status, update Codex if needed, and refresh models.",
    };
  } finally {
    options.signal.removeEventListener("abort", abort);
    await client?.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}
