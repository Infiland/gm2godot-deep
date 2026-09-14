import type { AgentRunResult } from "../agents/runtime.ts";
import type { ProducedBy } from "./schemas.ts";

/** Runtime model selection (including free fallback) supersedes the configured default in evidence. */
export function provenanceForResult(
  fallback: ProducedBy,
  result: Pick<AgentRunResult, "usage" | "provenance">,
): ProducedBy {
  const actual = result.provenance;
  const { provider: _provider, model: _model, ...rest } = fallback;
  return {
    ...rest,
    usage: result.usage,
    runtime: actual?.runtime ?? fallback.runtime,
    simulated: (actual?.runtime ?? fallback.runtime) === "mock",
    ...((actual ? actual.provider : fallback.provider)
      ? { provider: (actual ? actual.provider : fallback.provider)! }
      : {}),
    ...((actual ? actual.model : fallback.model)
      ? { model: (actual ? actual.model : fallback.model)! }
      : {}),
  };
}
