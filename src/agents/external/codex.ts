import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { startProcess, stopProcess } from "./process.ts";
import { resolveCodexExecutable, type ResolvedCodex } from "./codexExecutable.ts";
import { TransportFailure } from "./transport.ts";
import type { AgentTransport } from "./transport.ts";
import { ZERO_USAGE, type Usage } from "../runtime.ts";

const MessageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type Message = z.output<typeof MessageSchema>;

/** The public runtime label is a sentinel for the user's configured Codex provider. */
export function normalizeCodexProvider(provider?: string | null): string | null {
  const selected = provider?.trim() || null;
  return selected === "codex" ? null : selected;
}

const DISABLED_FEATURES = [
  "hooks", "plugins", "shell_tool", "unified_exec", "multi_agent",
  "multi_agent_v2", "apps", "browser_use", "browser_use_external",
  "computer_use", "image_generation", "view_image", "skill_search",
  "tool_suggest", "code_mode", "code_mode_host", "sleep_tool",
] as const;

function isolatedConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {
    web_search: "disabled", mcp_servers: {}, project_doc_max_bytes: 0,
  };
  for (const feature of DISABLED_FEATURES) config[`features.${feature}`] = false;
  return config;
}
export class CodexConnection {
  private child: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<(m: Message) => void>();
  private disconnected = false;
  private closing: Promise<void> | null = null;
  constructor(executable: string | ResolvedCodex | null | undefined, cwd: string, provider?: string | null) {
    const resolved = executable && typeof executable === "object"
      ? executable : resolveCodexExecutable(executable);
    if (!resolved) throw new Error("Codex was not found. Install Codex CLI or select its executable path.");
    const selectedProvider = normalizeCodexProvider(provider);
    // Apply isolation before app-server startup, including account/model discovery.
    // Keep CODEX_HOME and Codex's credential store intact so its existing sign-in is reused.
    const args = [...resolved.args, "app-server", "--listen", "stdio://"];
    for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
    args.push("--config", 'web_search="disabled"', "--config", "mcp_servers={}", "--config", "project_doc_max_bytes=0");
    if (selectedProvider) args.push("--config", `model_provider=${JSON.stringify(selectedProvider)}`);
    this.child = startProcess(
      resolved.command,
      args,
      cwd,
    );
    this.child.stderr.resume();
    this.child.on("error", () => this.fail());
    this.child.on("close", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (line.length > 8_000_000) {
        this.fail();
        void this.close();
        return;
      }
      let message: Message;
      try {
        message = MessageSchema.parse(JSON.parse(line));
      } catch {
        this.fail();
        void this.close();
        return;
      }
      if (typeof message.id === "number" && !message.method) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          message.error
            ? pending.reject(new Error("Codex request rejected"))
            : pending.resolve(message.result);
        }
        return;
      }
      // No native tool or approval can be approved by an unattended conversion agent.
      if (message.id !== undefined && message.method) {
        this.child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message:
                "Native tool/approval requests are disabled; use the structured host relay",
            },
          }) + "\n",
        );
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }
  private fail(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const p of this.pending.values())
      p.reject(new Error("Codex app-server disconnected"));
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ method: "transport/disconnected" });
  }
  call(method: string, params: unknown): Promise<unknown> {
    if (this.disconnected) return Promise.reject(new Error("Codex app-server disconnected"));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(new Error("Codex stdin unavailable"));
          }
        },
      );
    });
  }
  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ method }) + "\n");
  }
  on(listener: (m: Message) => void): () => void {
    this.listeners.add(listener);
    if (this.disconnected) queueMicrotask(() => listener({ method: "transport/disconnected" }));
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closing ??= (async () => {
      await stopProcess(this.child);
      this.fail();
    })();
    await this.closing;
  }
}
export function codexTransport(
  executable: string | null | undefined,
  cwd: string,
): AgentTransport {
  let connection: CodexConnection | null = null;
  return {
    close: async () => {
      await connection?.close();
      connection = null;
    },
    complete: async (request) => {
      let activeClient: CodexConnection | null = null;
      const onAbort = (): void => {
        void activeClient?.close();
      };
      let usage: Usage = ZERO_USAGE;
      try {
        request.signal.throwIfAborted();
        const client = new CodexConnection(executable, cwd, request.provider);
        activeClient = connection = client;
        request.signal.addEventListener("abort", onAbort, { once: true });
        request.signal.throwIfAborted();
        await client.call("initialize", {
          clientInfo: { name: "gm2godot-deep", version: "1" },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
        const started = z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(await client.call("thread/start", {
          model: request.model,
          modelProvider: normalizeCodexProvider(request.provider),
          allowProviderModelFallback: false,
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          baseInstructions: request.system,
          config: isolatedConfig(),
          selectedCapabilityRoots: [],
          dynamicTools: [],
        }));
        let text = "";
        const completed = new Promise<unknown>((resolve, reject) => {
          const unsubscribe = client.on((message) => {
            const params = message.params ?? {};
            if (message.method === "thread/tokenUsage/updated") {
              const report = params["tokenUsage"] as
                | {
                    total?: {
                      inputTokens?: number;
                      outputTokens?: number;
                      cachedInputTokens?: number;
                      cacheWriteInputTokens?: number;
                    };
                  }
                | undefined;
              const total = report?.total;
              if (total)
                usage = {
                  input: Math.max(
                    0,
                    (total.inputTokens ?? 0) - (total.cachedInputTokens ?? 0),
                  ),
                  output: total.outputTokens ?? 0,
                  cacheRead: total.cachedInputTokens ?? 0,
                  cacheWrite: total.cacheWriteInputTokens ?? 0,
                  costUsd: 0,
                  reported: true,
                };
            }
            if (message.method === "item/agentMessage/delta")
              text += String(params["delta"] ?? "");
            if (message.method === "item/completed") {
              const item = params["item"] as
                | { type?: string; text?: string }
                | undefined;
              if (item?.type === "agentMessage" && item.text) text = item.text;
            }
            if (message.method === "turn/completed") {
              unsubscribe();
              const turn = params["turn"] as { status?: string } | undefined;
              if (turn?.status !== "completed")
                reject(new Error("Codex turn did not complete"));
              else {
                try {
                  resolve(JSON.parse(text));
                } catch {
                  reject(new Error("Codex returned malformed structured JSON"));
                }
              }
            }
            if (message.method === "transport/disconnected") {
              unsubscribe();
              reject(new Error("Codex disconnected during turn"));
            }
          });
        });
        void completed.catch(() => {}); // turn/start failure closes the transport before the waiter is awaited.
        await client.call("turn/start", {
          threadId: started.thread.id,
          input: [{ type: "text", text: request.prompt, text_elements: [] }],
          outputSchema: request.schema,
        });
        const value = await completed;
        return { value, usage };
      } catch {
        throw new TransportFailure(
          "Codex request failed or was interrupted",
          usage,
        );
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        await activeClient?.close();
        if (connection === activeClient) connection = null;
      }
    },
  };
}
