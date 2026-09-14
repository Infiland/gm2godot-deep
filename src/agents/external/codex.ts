import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { startProcess, stopProcess } from "./process.ts";
import { TransportFailure } from "./transport.ts";
import type { AgentTransport } from "./transport.ts";
import { ZERO_USAGE, type Usage } from "../runtime.ts";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
export class CodexConnection {
  private child: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<(m: Message) => void>();
  constructor(executable: string, cwd: string) {
    this.child = startProcess(
      executable,
      ["app-server", "--listen", "stdio://"],
      cwd,
    );
    this.child.stderr.resume();
    this.child.on("error", () => this.fail());
    this.child.on("close", () => this.fail());
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (line.length > 8_000_000) {
        this.fail();
        void this.close();
        return;
      }
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
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
    for (const p of this.pending.values())
      p.reject(new Error("Codex app-server disconnected"));
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ method: "transport/disconnected" });
  }
  call(method: string, params: unknown): Promise<unknown> {
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
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    await stopProcess(this.child);
    this.fail();
  }
}
export function codexTransport(
  executable: string,
  cwd: string,
): AgentTransport {
  let connection: CodexConnection | null = null;
  return {
    close: async () => {
      await connection?.close();
      connection = null;
    },
    complete: async (request) => {
      const client = new CodexConnection(executable, cwd);
      connection = client;
      const onAbort = (): void => {
        void client.close();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      let usage: Usage = ZERO_USAGE;
      try {
        request.signal.throwIfAborted();
        await client.call("initialize", {
          clientInfo: { name: "gm2godot-deep", version: "1" },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
        const disabled = [
          "shell_tool",
          "unified_exec",
          "multi_agent",
          "multi_agent_v2",
          "apps",
          "browser_use",
          "browser_use_external",
          "computer_use",
          "image_generation",
          "view_image",
          "skill_search",
          "tool_suggest",
          "code_mode",
          "code_mode_host",
          "sleep_tool",
        ];
        const config: Record<string, unknown> = {
          web_search: "disabled",
          mcp_servers: {},
          project_doc_max_bytes: 0,
        };
        for (const feature of disabled) config[`features.${feature}`] = false;
        const started = (await client.call("thread/start", {
          model: request.model,
          modelProvider: request.provider,
          allowProviderModelFallback: false,
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          baseInstructions: request.system,
          config,
          selectedCapabilityRoots: [],
          dynamicTools: [],
        })) as { thread: { id: string } };
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
        await client.close();
        connection = null;
      }
    },
  };
}
