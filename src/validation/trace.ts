import { DeepError } from "../util/result.ts";
import { deepEqual } from "../util/json.ts";
import { TraceFileSchema } from "../evidence/schemas.ts";
import type { TraceFile } from "../evidence/schemas.ts";

/**
 * The recorded-trace interface for level D behavioural verification.
 *
 * A trace is a *recorded expectation* plus a *recorded observation*; nothing here infers behaviour
 * from source text. The comparison is positional — events are never sorted — and only payload keys a
 * caller explicitly declares optional are ignored. A comparison never reports a difference it cannot
 * name.
 */

export const RECORDED_TRACE_SCHEMA_VERSION = 1;

/** The scenario harness prints exactly one `DEEP_TRACE <json>` line; nothing else is read. */
export const DEEP_TRACE_PREFIX = "DEEP_TRACE ";

export type { TraceFile };
export type TraceEvent = TraceFile["events"][number];

/** Marker used in differences for a payload key that is absent on one side (never a real value). */
export const ABSENT_PAYLOAD_VALUE = "<absent>";

export interface TraceDifference {
  /** Step index of the event the difference belongs to. */
  readonly step: number;
  readonly kind: string;
  readonly target: string;
  /** `length`, `step`, `kind`, `target`, or `payload.<key>`. */
  readonly field: string;
  readonly expected: unknown;
  readonly observed: unknown;
}

export interface TraceComparison {
  readonly equal: boolean;
  readonly differences: readonly TraceDifference[];
}

/** Parse a recorded-trace file (or inline object) against the `schemaVersion: 1` schema. */
export function parseTrace(raw: unknown): TraceFile {
  const parsed = TraceFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeepError(
      "GM2DEEP-TRACE-INVALID",
      `recorded trace does not match schemaVersion ${RECORDED_TRACE_SCHEMA_VERSION}`,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

/**
 * Read the single `DEEP_TRACE <json>` line a scenario prints. Zero lines and several lines are both
 * errors: a comparison against an ambiguous observation would be meaningless.
 */
export function observeTrace(stdout: string): TraceFile["events"] {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(DEEP_TRACE_PREFIX));
  const first = lines[0];
  if (first === undefined) {
    throw new DeepError("GM2DEEP-TRACE-MISSING", `scenario output contained no line starting with ${DEEP_TRACE_PREFIX}`, {
      stdoutTail: stdout.slice(-2000),
    });
  }
  if (lines.length > 1) {
    throw new DeepError("GM2DEEP-TRACE-AMBIGUOUS", `scenario output contained ${lines.length} trace lines`, {
      lines: lines.slice(0, 4),
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(first.slice(DEEP_TRACE_PREFIX.length));
  } catch (error) {
    throw new DeepError("GM2DEEP-TRACE-INVALID", "trace line is not valid JSON", {
      line: first.slice(0, 2000),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const events = TraceFileSchema.shape.events.safeParse(payload);
  if (!events.success) {
    throw new DeepError("GM2DEEP-TRACE-INVALID", "trace line JSON is not an event sequence", {
      issues: events.error.issues,
    });
  }
  return events.data;
}

function payloadDifference(
  index: number,
  expected: TraceEvent,
  observed: TraceEvent,
  key: string,
): TraceDifference | null {
  const inExpected = Object.hasOwn(expected.payload, key);
  const inObserved = Object.hasOwn(observed.payload, key);
  if (inExpected && inObserved && deepEqual(expected.payload[key], observed.payload[key])) return null;
  return {
    step: index,
    kind: expected.kind,
    target: expected.target,
    field: `payload.${key}`,
    expected: inExpected ? expected.payload[key] : ABSENT_PAYLOAD_VALUE,
    observed: inObserved ? observed.payload[key] : ABSENT_PAYLOAD_VALUE,
  };
}

/**
 * Compare two event sequences positionally. Normalisation is limited to the payload keys the caller
 * declares optional; event order, step numbers, kinds, targets and every other payload key must match
 * exactly. A length mismatch is reported as one explicit difference rather than as a truncated
 * comparison.
 */
export function compareTraces(
  expected: readonly TraceEvent[],
  observed: readonly TraceEvent[],
  options: { readonly optionalPayloadKeys?: readonly string[] } = {},
): TraceComparison {
  const optional = new Set(options.optionalPayloadKeys ?? []);
  const differences: TraceDifference[] = [];
  const overlap = Math.min(expected.length, observed.length);
  for (let index = 0; index < overlap; index += 1) {
    const expectedEvent = expected[index];
    const observedEvent = observed[index];
    if (expectedEvent === undefined || observedEvent === undefined) continue;
    if (expectedEvent.step !== observedEvent.step) {
      differences.push({
        step: index,
        kind: expectedEvent.kind,
        target: expectedEvent.target,
        field: "step",
        expected: expectedEvent.step,
        observed: observedEvent.step,
      });
    }
    if (expectedEvent.kind !== observedEvent.kind) {
      differences.push({
        step: index,
        kind: expectedEvent.kind,
        target: expectedEvent.target,
        field: "kind",
        expected: expectedEvent.kind,
        observed: observedEvent.kind,
      });
    }
    if (expectedEvent.target !== observedEvent.target) {
      differences.push({
        step: index,
        kind: expectedEvent.kind,
        target: expectedEvent.target,
        field: "target",
        expected: expectedEvent.target,
        observed: observedEvent.target,
      });
    }
    const keys = new Set([...Object.keys(expectedEvent.payload), ...Object.keys(observedEvent.payload)]);
    for (const key of [...keys].sort()) {
      if (optional.has(key)) continue;
      const difference = payloadDifference(index, expectedEvent, observedEvent, key);
      if (difference !== null) differences.push(difference);
    }
  }
  if (expected.length !== observed.length) {
    const last = observed.length > expected.length ? expected[expected.length - 1] : observed[observed.length - 1];
    differences.push({
      step: last === undefined ? overlap : last.step,
      kind: last === undefined ? "trace" : last.kind,
      target: last === undefined ? "sequence" : last.target,
      field: "length",
      expected: expected.length,
      observed: observed.length,
    });
  }
  return { equal: differences.length === 0, differences };
}

/** One-line-per-difference rendering used in check reasons and report text. */
export function describeDifferences(differences: readonly TraceDifference[], limit = 8): string {
  if (differences.length === 0) return "no differences";
  const shown = differences
    .slice(0, limit)
    .map(
      (difference) =>
        `step ${String(difference.step)} ${difference.kind}/${difference.target} ${difference.field}: expected ${JSON.stringify(difference.expected)} observed ${JSON.stringify(difference.observed)}`,
    )
    .join("; ");
  return differences.length > limit ? `${shown}; (+${differences.length - limit} more)` : shown;
}
