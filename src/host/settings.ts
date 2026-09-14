import { writeConfig } from "../config/load.ts";
import { ConfigSchema } from "../config/schema.ts";
import { canonicalJson } from "../util/json.ts";
import { DeepError } from "../util/result.ts";
import { openWorkspace } from "../workspaces/workspace.ts";
import type { JobRecord } from "./journal.ts";
import { HostSettingsSchema, type ResearchParams } from "./protocol.ts";

export function configuredBudgets(
  settings: ResearchParams["settings"],
): Record<string, number | null> {
  const b = settings.budgets;
  if (!b) return {};
  const result: Record<string, number | null> = {};
  for (const key of [
    "perTaskTokens",
    "perTaskCostUsd",
    "perRunTokens",
    "perRunCostUsd",
  ] as const)
    if (b[key] !== undefined) result[key] = b[key];
  if (b.maxTokens !== undefined) result["perRunTokens"] = b.maxTokens;
  if (b.maxCostUsd !== undefined) result["perRunCostUsd"] = b.maxCostUsd;
  return result;
}

/** An explicit paused selection changes future calls; completed artifacts keep their original provenance. */
export function updateResumeSettings(
  record: JobRecord,
  raw: unknown,
  validateOnly = false,
): ReturnType<typeof ConfigSchema.parse> {
  const settings = HostSettingsSchema.parse(raw);
  const supplied = raw as Record<string, unknown>;
  const workspace = openWorkspace(record.jobRoot),
    config = workspace.config;
  const agent = { ...config.agent };
  const identityKeys = [
    "runtime",
    "provider",
    "model",
    "roleOverrides",
    "freeOnly",
    "executable",
    "endpoint",
  ] as const;
  for (const key of identityKeys)
    if (key in supplied) Object.assign(agent, { [key]: settings[key] });
  for (const key of ["provider", "model", "executable", "endpoint"] as const)
    agent[key] = agent[key]?.trim() || null;
  if ((config.agent.runtime === "mock") !== (agent.runtime === "mock"))
    throw new DeepError(
      "HOST_SIMULATION_CHANGED",
      "Start a new job to switch between simulation and real models",
    );
  if (config.agent.freeOnly && !agent.freeOnly)
    throw new DeepError(
      "HOST_FREE_POLICY_CHANGED",
      "A free-only job cannot switch to paid models. Start a new job to change this policy.",
    );
  if (
    identityKeys.some((key) => key in supplied) &&
    agent.freeOnly &&
    (agent.runtime !== "opencode" ||
      (agent.provider && agent.provider !== "opencode") ||
      agent.endpoint ||
      Object.values(agent.roleOverrides).some(
        (r) =>
          (r.runtime && r.runtime !== "opencode") ||
          (r.provider && r.provider !== "opencode"),
      ))
  )
    throw new DeepError(
      "HOST_FREE_POLICY_CHANGED",
      "Free-only jobs require isolated OpenCode Zen models for every role.",
    );
  const previousIdentity = canonicalJson({
    runtime: config.agent.runtime,
    provider: config.agent.provider,
    model: config.agent.model,
    roles: config.agent.roleOverrides,
    freeOnly: config.agent.freeOnly,
  });
  const budgets = configuredBudgets(settings);
  const concurrency = settings.analysisWorkers ?? config.concurrency.analysis;
  const host = config.host;
  if (host === null)
    throw new DeepError("HOST_JOB_REQUIRED", "This is not a hosted job");
  const updated = ConfigSchema.parse({
    ...config,
    agent: {
      ...agent,
      budgets: { ...config.agent.budgets, ...budgets },
    },
    concurrency: {
      ...config.concurrency,
      analysis: agent.freeOnly
        ? Math.min(
            concurrency,
            "freeProviderConcurrency" in supplied
              ? settings.freeProviderConcurrency
              : host.freeProviderConcurrency,
          )
        : concurrency,
    },
    host: {
      ...host,
      researchModelIdentity: host.researchModelIdentity ?? previousIdentity,
      freeProviderConcurrency:
        "freeProviderConcurrency" in supplied
          ? settings.freeProviderConcurrency
          : host.freeProviderConcurrency,
      ...(settings.budgets?.maxSeconds === undefined
        ? {}
        : {
            maxSeconds:
              settings.budgets.maxSeconds === null
                ? null
                : (record.elapsedSeconds ?? 0) + settings.budgets.maxSeconds,
          }),
    },
    policy: {
      ...config.policy,
      ...("allowRemoteSourceUpload" in supplied
        ? { allowRemoteSourceUpload: settings.allowRemoteSourceUpload }
        : {}),
    },
  });
  if (!validateOnly) writeConfig(record.jobRoot, updated);
  return updated;
}
