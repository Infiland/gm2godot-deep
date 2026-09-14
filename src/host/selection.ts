import { isAutomaticModel } from "../models/freePolicy.ts";
import { canonicalJson } from "../util/json.ts";
import { discoverAgent, discoverPi } from "../agents/capabilities.ts";
import type { Config } from "../config/schema.ts";
import { DeepError } from "../util/result.ts";

export function selectionChanged(
  before: Config["agent"],
  after: Config["agent"],
): boolean {
  return [
    "runtime",
    "provider",
    "model",
    "roleOverrides",
    "freeOnly",
    "executable",
    "endpoint",
  ].some(
    (key) =>
      canonicalJson(before[key as keyof typeof before]) !==
      canonicalJson(after[key as keyof typeof after]),
  );
}

/** Validate an explicitly changed selection against adapter discovery before touching saved settings. */
export async function verifySelection(agent: Config["agent"]): Promise<void> {
  if (agent.runtime === "mock") return;
  const choices = [
    { runtime: agent.runtime, provider: agent.provider, model: agent.model },
    ...Object.values(agent.roleOverrides).map((role) => ({
      runtime: role.runtime ?? agent.runtime,
      provider: role.provider ?? agent.provider,
      model: role.model ?? agent.model,
    })),
  ];
  const seen = new Set<string>();
  for (const choice of choices) {
    const key = JSON.stringify(choice);
    if (seen.has(key)) continue;
    seen.add(key);
    if (choice.runtime === "mock")
      throw new DeepError(
        "HOST_MODEL_UNAVAILABLE",
        "Simulation cannot replace a model during a real job",
      );
    const capabilities =
      choice.runtime === "pi"
        ? await discoverPi(choice.provider ?? "", {})
        : await discoverAgent({
            runtime: choice.runtime,
            ...(agent.executable ? { executable: agent.executable } : {}),
            ...(agent.endpoint ? { endpoint: agent.endpoint } : {}),
            provider: choice.provider,
            freeOnly: agent.freeOnly,
            signal: AbortSignal.timeout(20000),
          });
    if (!capabilities.installed || capabilities.authenticated === false)
      throw new DeepError(
        "HOST_MODEL_UNAVAILABLE",
        capabilities.reason ?? "The selected provider is unavailable",
      );
    const candidates = capabilities.models.filter(
      (model) =>
        (!choice.model ||
          isAutomaticModel(choice.model) ||
          model.id === choice.model) &&
        (!choice.provider ||
          !model.provider ||
          model.provider === choice.provider) &&
        model.available !== false &&
        model.authenticated !== false &&
        (!agent.freeOnly || model.freeEligible === true),
    );
    if ((choice.model || agent.freeOnly) && !candidates.length)
      throw new DeepError(
        "HOST_MODEL_UNAVAILABLE",
        "The selected model was not returned as available by provider discovery. Refresh models and choose an available model.",
      );
  }
}
