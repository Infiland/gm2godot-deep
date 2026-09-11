import { nowIso } from "../util/ids.ts";
import type { AgentEventRecord } from "./runtime.ts";

/**
 * The runtime-agnostic event record. `AgentRuntime` implementations return `AgentEventRecord[]`, so the
 * shape itself is declared next to the runtime interface in `runtime.ts` and re-exported here for
 * consumers that only care about event recording/redaction.
 */
export type { AgentEventRecord };

/** Replacement written for any object key that names a credential. */
export const REDACTED = "[redacted]";

const SENSITIVE_KEY = /api[-_]?key|authorization|token|secret|password|credential/i;

/**
 * Recursively replace the value of every key that looks like a credential with `[redacted]`.
 *
 * Redaction is key-based: a secret carried in a *value* under an innocuous key is not detected. That is
 * deliberate — the host never places credentials in prompts, artifacts or events, so this is a second line
 * of defence against provider payloads that echo an `authorization` header or an `api_key` field, not the
 * primary control. Map/Set/Date are handled so a structured provider payload cannot smuggle a credential
 * past the walk as an opaque object.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of value) out[String(key)] = redactValue(entry, seen);
    return out;
  }
  if (value instanceof Set) return [...value].map((entry) => redactValue(entry, seen));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, seen);
  }
  return out;
}

/** Join the text blocks of a message/tool-result `content` array. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if (!("type" in block) || block.type !== "text") continue;
    if (!("text" in block) || typeof block.text !== "string") continue;
    parts.push(block.text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function assistantText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  if (!("role" in message) || message.role !== "assistant") return undefined;
  return "content" in message ? contentText(message.content) : undefined;
}

function eventText(event: { type: string } & Record<string, unknown>): string | undefined {
  switch (event.type) {
    case "message_start":
    case "message_end":
    case "turn_end":
      return assistantText(event["message"]);
    case "tool_execution_end": {
      const result = event["result"];
      if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
      return contentText(result.content);
    }
    default:
      return undefined;
  }
}

function eventDetail(event: { type: string } & Record<string, unknown>): unknown {
  switch (event.type) {
    case "tool_execution_start":
      return event["args"];
    case "tool_execution_end": {
      const result = event["result"];
      if (typeof result !== "object" || result === null || !("details" in result)) return undefined;
      return result.details;
    }
    case "agent_end": {
      const messages = event["messages"];
      return { messageCount: Array.isArray(messages) ? messages.length : 0 };
    }
    case "turn_end": {
      const toolResults = event["toolResults"];
      return { toolResultCount: Array.isArray(toolResults) ? toolResults.length : 0 };
    }
    default:
      return undefined;
  }
}

/**
 * Project one SDK/agent event onto a credential-free record. Only a fixed set of fields is read, so a
 * provider payload attached to an event cannot reach the transcript wholesale.
 */
export function recordEvent(seq: number, event: { type: string } & Record<string, unknown>): AgentEventRecord {
  const toolName = event["toolName"];
  const toolCallId = event["toolCallId"];
  const isError = event["isError"];
  const text = eventText(event);
  const detail = eventDetail(event);
  return {
    seq,
    at: nowIso(),
    type: event.type,
    ...(typeof toolName === "string" ? { toolName } : {}),
    ...(typeof toolCallId === "string" ? { toolCallId } : {}),
    ...(typeof isError === "boolean" ? { isError } : {}),
    ...(text === undefined ? {} : { text }),
    ...(detail === undefined ? {} : { detail: redact(detail) }),
  };
}
