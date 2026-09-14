import { isolatedOpenCodeEnvironment } from "./opencodeEnvironment.ts";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { startProcess, stopProcess } from "./process.ts";
import { TransportFailure } from "./transport.ts";
import type { AgentTransport, CompletionRequest } from "./transport.ts";
import { ZERO_USAGE } from "../runtime.ts";
export interface OpenCodeModel {
  id: string;
  provider: string;
  name: string;
  cost: unknown;
  toolcall: boolean;
  status?: string;
  providerName?: string;
  connected?: boolean;
}
export function localEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "OpenCode endpoint must be an authenticated localhost HTTP server root",
    );
  return url.origin;
}
async function port(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Cannot allocate server port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
export class OpenCodeClient implements AgentTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private endpoint: string | null = null;
  private password: string;
  private ready: Promise<void> | null = null;
  readonly options: {
    executable: string;
    cwd: string;
    endpoint?: string | null;
    password?: string;
    provider?: string | null;
    freeOnly?: boolean;
    apiKey?: string;
  };
  constructor(options: {
    executable: string;
    cwd: string;
    endpoint?: string | null;
    password?: string;
    provider?: string | null;
    freeOnly?: boolean;
    apiKey?: string;
  }) {
    this.options = options;
    this.password = options.password ?? randomBytes(32).toString("hex");
    if (options.endpoint) {
      if (!options.password)
        throw new Error(
          "Existing OpenCode endpoint requires a server password",
        );
      this.endpoint = localEndpoint(options.endpoint);
    }
  }
  private async start(signal: AbortSignal): Promise<void> {
    if (this.endpoint) return;
    this.endpoint = `http://127.0.0.1:${await port()}`;
    const config = {
      permission: { "*": "deny" },
      agent: {
        "deep-relay": {
          mode: "primary",
          permission: { "*": "deny" },
          tools: { "*": false },
        },
      },
      plugin: [],
      mcp: {},
      share: "disabled",
      autoupdate: false,
    };
    this.child = startProcess(
      this.options.executable,
      [
        "serve",
        "--pure",
        "--hostname",
        "127.0.0.1",
        "--port",
        new URL(this.endpoint).port,
      ],
      this.options.cwd,
      isolatedOpenCodeEnvironment({
        cwd: this.options.cwd,
        password: this.password,
        config,
        provider: this.options.provider ?? null,
        freeOnly: this.options.freeOnly ?? false,
        ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
      }),
    );
    let failure = false;
    this.child.once("error", () => {
      failure = true;
    });
    this.child.stdout.resume();
    this.child.stderr.resume();
    for (let i = 0; i < 100; i++) {
      signal.throwIfAborted();
      if (failure || this.child.exitCode !== null)
        throw new Error("OpenCode server failed to start");
      try {
        await this.request("/global/health", undefined, signal);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("OpenCode server startup timed out");
  }
  async request(
    path: string,
    body: unknown,
    signal: AbortSignal,
    method?: string,
  ): Promise<unknown> {
    if (!this.endpoint) throw new Error("OpenCode server has not started");
    const response = await fetch(this.endpoint + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (!response.ok)
      throw new Error(`OpenCode request failed (${response.status})`);
    if (response.status === 204) return null;
    return await response.json();
  }
  async catalog(signal: AbortSignal): Promise<OpenCodeModel[]> {
    this.ready ??= this.start(signal);
    await this.ready;
    const result = (await this.request("/provider", undefined, signal)) as {
      all?: {
        id: string;
        name?: string;
        models: Record<
          string,
          {
            id: string;
            name: string;
            cost?: unknown;
            capabilities?: { toolcall?: boolean };
            status?: string;
          }
        >;
      }[];
      connected?: string[];
    };
    return (result.all ?? []).flatMap((p) =>
      Object.values(p.models).map((m) => ({
        id: m.id,
        name: m.name,
        provider: p.id,
        providerName: p.name ?? p.id,
        connected: result.connected?.includes(p.id) ?? false,
        cost: m.cost,
        toolcall: m.capabilities?.toolcall === true,
        ...(m.status ? { status: m.status } : {}),
      })),
    );
  }
  async complete(request: CompletionRequest) {
    this.ready ??= this.start(request.signal);
    await this.ready;
    if (!this.options.endpoint) {
      // Pin every implicit helper (title/summary/compaction) to the same selected model.
      await this.request(
        "/config",
        {
          model: `${request.provider ?? "opencode"}/${request.model}`,
          small_model: `${request.provider ?? "opencode"}/${request.model}`,
          agent: {
            "deep-relay": {
              model: `${request.provider ?? "opencode"}/${request.model}`,
              options: { maxOutputTokens: request.maxTokens },
            },
            title: { disable: true },
            summary: { disable: true },
            compaction: { disable: true },
          },
        },
        request.signal,
        "PATCH",
      );
    }
    const session = (await this.request(
      "/session",
      {
        title: "GM2Godot bounded host tool request",
        permission: [{ permission: "*", pattern: "*", action: "deny" }],
      },
      request.signal,
    )) as { id: string };
    const abort = (): void => {
      void this.request(
        `/session/${encodeURIComponent(session.id)}/abort`,
        {},
        AbortSignal.timeout(3000),
      ).catch(() => {});
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const tools = (await this.request(
        `/experimental/tool?provider=${encodeURIComponent(request.provider ?? "opencode")}&model=${encodeURIComponent(request.model ?? "")}`,
        undefined,
        request.signal,
      )) as { id: string }[];
      const denied = Object.fromEntries(tools.map((tool) => [tool.id, false]));
      const reply = (await this.request(
        `/session/${encodeURIComponent(session.id)}/message`,
        {
          model: {
            providerID: request.provider ?? "opencode",
            modelID: request.model,
          },
          ...(this.options.endpoint ? {} : { agent: "deep-relay" }),
          system: `${request.system}\nReturn only a JSON object matching this JSON Schema: ${JSON.stringify(request.schema)}. Do not use markdown fences.`,
          tools: denied,
          parts: [{ type: "text", text: request.prompt }],
        },
        request.signal,
      )) as {
        info?: {
          structured?: unknown;
          error?: unknown;
          cost?: number;
          tokens?: {
            input?: number;
            output?: number;
            cache?: { read?: number; write?: number };
          };
        };
        parts?: { type: string; text?: string }[];
      };
      const tokens = reply.info?.tokens;
      const usage = tokens
        ? {
            input: tokens.input ?? 0,
            output: tokens.output ?? 0,
            cacheRead: tokens.cache?.read ?? 0,
            cacheWrite: tokens.cache?.write ?? 0,
            costUsd: reply.info?.cost ?? 0,
            reported: true,
          }
        : ZERO_USAGE;
      if (reply.info?.error)
        throw new TransportFailure(
          "OpenCode provider returned an error",
          usage,
        );
      try {
        const value =
          reply.info?.structured ??
          JSON.parse(
            (reply.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("\n"),
          );
        return { value, usage };
      } catch {
        throw new TransportFailure(
          "OpenCode returned malformed structured JSON",
          usage,
        );
      }
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
  }
  async close(): Promise<void> {
    if (this.child) await stopProcess(this.child);
    this.child = null;
  }
}
