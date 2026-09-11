import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { nowIso } from "../../util/ids.ts";
import { DeepError } from "../../util/result.ts";
import { recordEvent } from "../events.ts";
import { emptyUsage, mergeUsage } from "../result.ts";
import type { AgentEventRecord, Usage } from "../runtime.ts";

/** Default retained-event budget; head and tail are kept, the middle is dropped. */
export const DEFAULT_MAX_EVENTS = 5000;

export interface ToolCallRecord {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args?: unknown;
  readonly isError: boolean;
}

export interface EventRecorderOptions {
  /** The role's result tool, from `roleConfig(role).resultTool`. */
  readonly resultToolName: string | null;
  /** Retained event budget. Must be at least 3 so head, marker and tail all fit. */
  readonly maxEvents?: number;
  /** Invoked after each merged `message_end` usage, so the runtime can enforce budgets mid-run. */
  readonly onUsage?: (usage: Usage) => void;
}

/**
 * Subscribes to an `Agent`, projects each event to a credential-free record and accumulates the run's
 * result payload and usage.
 *
 * Nothing here retains provider payloads: `recordEvent` reads a fixed set of fields and redacts them.
 * When more than `maxEvents` events arrive the *middle* is dropped — the opening events (what the model
 * was asked to do) and the most recent events (why it stopped) are the ones worth keeping — and a single
 * `events_truncated` marker records how many were discarded.
 */
export class EventRecorder {
  private readonly head: AgentEventRecord[] = [];
  private readonly tail: AgentEventRecord[] = [];
  private readonly headCapacity: number;
  private readonly tailCapacity: number;
  private readonly resultToolName: string | null;
  private readonly onUsage: ((usage: Usage) => void) | null;
  private readonly unsubscribeFn: () => void;
  private readonly calls = new Map<string, ToolCallRecord>();
  private droppedEvents = 0;
  private sequence = 0;
  private turns = 0;
  private usageValue: Usage = emptyUsage();
  private capturedValue: unknown;
  private capturedObserved = false;
  private assistantErrorValue: string | undefined;

  constructor(agent: Agent, options: EventRecorderOptions) {
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (!Number.isInteger(maxEvents) || maxEvents < 3) {
      throw new DeepError("GM2DEEP-PI-EVENTS-LIMIT", "maxEvents must be an integer of at least 3", {
        maxEvents,
      });
    }
    this.headCapacity = Math.floor(maxEvents / 2);
    this.tailCapacity = maxEvents - this.headCapacity - 1;
    this.resultToolName = options.resultToolName;
    this.onUsage = options.onUsage ?? null;
    this.unsubscribeFn = agent.subscribe((event) => {
      this.handle(event);
    });
  }

  /** Detach from the agent. `Agent` has no `close()`; dropping the subscription is the whole disposal. */
  unsubscribe(): void {
    this.unsubscribeFn();
  }

  private handle(event: AgentEvent): void {
    this.sequence += 1;
    this.append(recordEvent(this.sequence, event));
    if (event.type === "tool_execution_start") {
      this.recordToolCall(event.toolName, event.toolCallId, event.args, false);
    }
    if (event.type === "tool_execution_end") {
      this.recordToolCall(event.toolName, event.toolCallId, undefined, event.isError);
      if (!event.isError && this.isResultCall(event.toolName, event.result)) {
        this.capturedObserved = true;
        this.capturedValue = event.result?.details;
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.usageValue = mergeUsage(this.usageValue, event.message.usage);
      if (this.onUsage !== null) this.onUsage(this.usageValue);
      if (event.message.stopReason === "error") {
        this.assistantErrorValue = event.message.errorMessage ?? "the provider reported an error stop reason";
      }
    }
    if (event.type === "turn_end") this.turns += 1;
  }

  /** The result tool is either the role's declared tool or any tool that asked the SDK to terminate. */
  private isResultCall(toolName: string, result: unknown): boolean {
    if (this.resultToolName !== null && toolName === this.resultToolName) return true;
    return typeof result === "object" && result !== null && "terminate" in result && result.terminate === true;
  }

  private append(record: AgentEventRecord): void {
    if (this.head.length < this.headCapacity) {
      this.head.push(record);
      return;
    }
    this.tail.push(record);
    if (this.tail.length > this.tailCapacity) {
      this.tail.shift();
      this.droppedEvents += 1;
    }
  }

  /** Retained events in order, with a truncation marker where the middle was discarded. */
  events(): readonly AgentEventRecord[] {
    if (this.droppedEvents === 0) return [...this.head, ...this.tail];
    const marker: AgentEventRecord = {
      seq: -1,
      at: nowIso(),
      type: "events_truncated",
      detail: { dropped: this.droppedEvents },
    };
    return [...this.head, marker, ...this.tail];
  }

  /** The last successful result payload, or `undefined` when none was captured. */
  captured(): unknown {
    return this.capturedValue;
  }

  /** Whether a successful result call was observed, independent of its payload. */
  hasCaptured(): boolean {
    return this.capturedObserved;
  }

  /** Merged usage so far. `reported: false` means the provider never supplied a counter. */
  usage(): Usage {
    return this.usageValue;
  }

  /** Number of completed turns observed. */
  turnCount(): number {
    return this.turns;
  }

  /** Last assistant `stopReason: "error"` message, when the provider reported one. */
  assistantError(): string | undefined {
    return this.assistantErrorValue;
  }

  toolCalls(): readonly ToolCallRecord[] {
    return [...this.calls.values()];
  }

  /**
   * Record a tool call. Called from the event stream (start then end, keyed by `toolCallId`) and usable
   * directly by the runtime for a call that never reached execution; repeated ids merge rather than
   * duplicating, and a failure once seen is never downgraded.
   */
  recordToolCall(toolName: string, toolCallId: string, args?: unknown, isError = false): void {
    const existing = this.calls.get(toolCallId);
    const mergedArgs = args === undefined ? existing?.args : args;
    this.calls.set(toolCallId, {
      toolName,
      toolCallId,
      ...(mergedArgs === undefined ? {} : { args: mergedArgs }),
      isError: isError || existing?.isError === true,
    });
  }
}
