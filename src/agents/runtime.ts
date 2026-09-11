import type { z } from "zod";
import type { AgentRoleName } from "../storage/types.ts";

/** Re-exported because every role-scoped public interface here is keyed by it. */
export type { AgentRoleName };
import type { Logger } from "../util/log.ts";

/** Roots a role may read from or write into. Anything outside these is denied by the host. */
export interface ToolContext {
  readonly role: AgentRoleName;
  readonly taskId: string;
  readonly workspaceRoots: Readonly<Record<"source" | "baseline" | "port" | "task" | "evidence", string>>;
  readonly allowlist: { readonly read: readonly string[]; readonly write: readonly string[] };
  readonly logger: Logger;
  /** Called when a guard rejects a request, so the denial lands in `task_events`. */
  readonly recordPolicyDenial: (detail: { tool: string; reason: string; path?: string }) => void;
  readonly signal: AbortSignal;
  /** The attempt number, used to name patch artifacts. */
  readonly attempt: number;
}

export interface ToolOutcome {
  readonly text: string;
  readonly details?: unknown;
  /** Terminate the conversation and capture `details` as the role result. */
  readonly terminate?: boolean;
}

/**
 * A tool the host exposes to a model. The handler runs in the trusted host process, resolves every path
 * through `src/workspaces/guards.ts` against the task-scoped allowed roots, and throws to signal failure.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly execute: (args: unknown, context: ToolContext) => Promise<ToolOutcome>;
}

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
  /** False means the provider did not report usage; the counters are then zero by construction. */
  readonly reported: boolean;
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, reported: false };

export interface AgentEventRecord {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly text?: string;
  readonly detail?: unknown;
}

export interface AgentRunRequest {
  readonly role: AgentRoleName;
  readonly taskId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly tools: readonly ToolSpec[];
  readonly workspaceRoots: ToolContext["workspaceRoots"];
  readonly allowlist: ToolContext["allowlist"];
  readonly resultSchema: z.ZodTypeAny;
  readonly maxTurns: number;
  readonly timeoutSeconds: number;
  readonly budgets: { readonly tokens: number | null; readonly costUsd: number | null };
  readonly signal: AbortSignal;
  /** Host-owned credentials. Never serialized into an artifact, log or subprocess environment. */
  readonly credentials: Readonly<Record<string, string>>;
  readonly attempt: number;
  readonly logger: Logger;
  readonly recordPolicyDenial: ToolContext["recordPolicyDenial"];
}

export type AgentOutcome = "completed" | "aborted" | "timeout" | "failed" | "budget_exceeded" | "no_result";

export interface AgentRunResult {
  readonly outcome: AgentOutcome;
  /** Validated against `resultSchema` when `outcome === "completed"`. */
  readonly result?: unknown;
  readonly transcriptPath: string;
  readonly usage: Usage;
  readonly events: readonly AgentEventRecord[];
  readonly reason?: string;
}

export interface AgentRuntime {
  readonly id: "pi" | "mock";
  /** True when no model was exercised. Never true for the Pi runtime. */
  readonly simulated: boolean;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
