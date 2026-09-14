import type { Usage } from "../runtime.ts";
export interface CompletionRequest {
  system: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  schema: Record<string, unknown>;
  signal: AbortSignal;
  maxTokens: number;
}
export interface Completion {
  value: unknown;
  usage: Usage;
}
export interface AgentTransport {
  complete(request: CompletionRequest): Promise<Completion>;
  close(): Promise<void>;
}

/** Preserve provider-reported spend even when its answer cannot be used. */
export class TransportFailure extends Error {
  readonly usage: Usage;
  constructor(message: string, usage: Usage) {
    super(message);
    this.name = "TransportFailure";
    this.usage = usage;
  }
}
