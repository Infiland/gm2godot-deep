import type { AgentRunResult } from "../agents/runtime.ts";
import { DeepError } from "../util/result.ts";

/** Operational failures pause a hosted job; they are not findings about the source project. */
export function recoveryError(value: unknown): DeepError | null {
  if (
    value instanceof DeepError &&
    /BUDGET|RATE.LIMIT|PROVIDER.UNAVAILABLE/.test(value.code)
  )
    return value;
  const message = value instanceof Error ? value.message : String(value);
  if (
    /\b429\b|rate.?limit|too many requests|quota.?exceed|insufficient.?quota/i.test(
      message,
    )
  )
    return new DeepError(
      "HOST_PROVIDER_RATE_LIMITED",
      "The provider is rate limited. Progress is saved; choose another available model or resume later.",
      { reason: message },
    );
  if (
    /authentication|unauthorized|\b401\b|api.?key.*(?:missing|invalid)|no.*free.*model|free.*(?:unavailable|eligible)/i.test(
      message,
    )
  )
    return new DeepError(
      "HOST_PROVIDER_UNAVAILABLE",
      "The selected provider cannot continue. Progress is saved; check authentication or select another available model.",
      { reason: message },
    );
  return null;
}
export function resultRecoveryError(result: AgentRunResult): DeepError | null {
  if (result.outcome === "completed") return null;
  if (result.outcome === "budget_exceeded")
    return new DeepError(
      "GM2DEEP-BUDGET-EXCEEDED",
      result.reason ?? "The model budget is exhausted; progress is saved.",
    );
  return recoveryError(result.reason ?? result.outcome);
}
