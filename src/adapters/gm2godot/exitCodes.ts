/**
 * GM2Godot's `convert` exit codes and stdout summary, interpreted without guessing.
 *
 * Verified against `src/cli.py::_conversion_outcome_exit_code` at commit 38b3648:
 *   cancelled → 130; failed → 1; threshold exceeded → 2; partial without --allow-partial → 2;
 *   preflight error → 2; runtime exception → 1; otherwise 0.
 */

export type ConversionState = "success" | "partial" | "failed" | "cancelled";

export type InterpretedOutcome =
  | "success"
  | "partial"
  | "failed"
  | "cancelled"
  | "preflight_error"
  | "usage_error"
  | "unknown";

export interface OutcomeCounts {
  readonly requested: number;
  readonly executed: number;
  readonly completed: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface ConversionExitInterpretation {
  readonly state: ConversionState | null;
  readonly outcome: InterpretedOutcome;
  readonly summaryLine: string | null;
  readonly outcomeCounts: { readonly converters: OutcomeCounts; readonly resources: OutcomeCounts } | null;
  readonly failure: FailureKind | null;
  readonly detail: string | null;
}

export interface FailureKind {
  readonly kind: "preflight_error" | "runtime_error" | "threshold" | "usage";
  readonly diagnostic: unknown;
  readonly message: string | null;
}

const SUMMARY_PREFIX = "GM2Godot conversion outcome:";

function parseCounts(text: string): OutcomeCounts | null {
  const requested = /requested=(\d+)/.exec(text);
  const executed = /executed=(\d+)/.exec(text);
  const completed = /completed=(\d+)/.exec(text);
  const skipped = /skipped=(\d+)/.exec(text);
  const failed = /failed=(\d+)/.exec(text);
  if (!requested || !executed || !completed || !skipped || !failed) return null;
  return {
    requested: Number(requested[1]),
    executed: Number(executed[1]),
    completed: Number(completed[1]),
    skipped: Number(skipped[1]),
    failed: Number(failed[1]),
  };
}

/** Extract the single summary line and both count blocks from converter stdout. */
export function parseSummaryLine(stdout: string): ConversionExitInterpretation["outcomeCounts"] {
  const line = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith(SUMMARY_PREFIX))
    .pop();
  if (line === undefined) return null;
  const convertersMatch = /converters\[([^\]]*)\]/.exec(line);
  const resourcesMatch = /resources\[([^\]]*)\]/.exec(line);
  if (!convertersMatch || !resourcesMatch) return null;
  const converters = parseCounts(convertersMatch[1] ?? "");
  const resources = parseCounts(resourcesMatch[1] ?? "");
  if (!converters || !resources) return null;
  return { converters, resources };
}

function lastSummaryLine(stdout: string): string | null {
  const lines = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith(SUMMARY_PREFIX));
  return lines.length === 0 ? null : (lines[lines.length - 1] as string);
}

function classifyStderr(stderr: string): FailureKind | null {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return null;
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace !== -1) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(firstBrace));
      if (typeof parsed === "object" && parsed !== null) {
        return { kind: "preflight_error", diagnostic: parsed, message: null };
      }
    } catch {
      // Not a preflight JSON diagnostic; fall through to the plain-message branch.
    }
  }
  return { kind: "runtime_error", diagnostic: null, message: trimmed.split("\n").slice(-1)[0] ?? trimmed };
}

/**
 * Turn `(exit code, stdout, stderr)` into a state. Never reports `success` when the process failed,
 * and never reports progress when stdout carried no summary line.
 */
export function interpretConversionExit(input: {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly allowPartial: boolean;
}): ConversionExitInterpretation {
  const summaryLine = lastSummaryLine(input.stdout);
  const summaryState = summaryLine === null ? null : (/outcome:\s*(\w+)/.exec(summaryLine)?.[1] ?? null);
  const state = (summaryState === "success" || summaryState === "partial" || summaryState === "failed" || summaryState === "cancelled"
    ? summaryState
    : null) as ConversionState | null;
  const outcomeCounts = parseSummaryLine(input.stdout);
  const failure = classifyStderr(input.stderr);

  if (input.code === 0) {
    if (state === "success") return { state, outcome: "success", summaryLine, outcomeCounts, failure: null, detail: null };
    if (state === "partial") {
      return {
        state,
        outcome: "partial",
        summaryLine,
        outcomeCounts,
        failure: null,
        detail: input.allowPartial
          ? "conversion reported partial with --allow-partial"
          : "conversion reported partial without --allow-partial",
      };
    }
    return {
      state,
      outcome: "unknown",
      summaryLine,
      outcomeCounts,
      failure: null,
      detail: "exit status 0 without a parseable conversion outcome summary line",
    };
  }

  if (input.code === 130) return { state: state ?? "cancelled", outcome: "cancelled", summaryLine, outcomeCounts, failure, detail: null };
  if (input.code === 1) {
    const outcome: InterpretedOutcome = failure?.kind === "preflight_error" ? "preflight_error" : "failed";
    return { state, outcome, summaryLine, outcomeCounts, failure, detail: failure?.message ?? null };
  }
  if (input.code === 2) {
    const outcome: InterpretedOutcome = state === "partial" && !input.allowPartial ? "partial" : failure?.kind === "preflight_error" ? "preflight_error" : "failed";
    return {
      state,
      outcome,
      summaryLine,
      outcomeCounts,
      failure: failure ?? { kind: "threshold", diagnostic: null, message: "a conversion threshold or preflight check failed" },
      detail: failure?.message ?? "exit status 2 (threshold exceeded, partial without --allow-partial, or preflight failure)",
    };
  }
  return {
    state,
    outcome: "unknown",
    summaryLine,
    outcomeCounts,
    failure,
    detail: `unrecognised exit status ${String(input.code)}`,
  };
}
