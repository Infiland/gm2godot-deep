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

/** Resource limits can change during a pause; research/model identity cannot silently change. */
export function updateResumeSettings(record: JobRecord, raw: unknown): void {
  const settings = HostSettingsSchema.parse(raw);
  const supplied = raw as Record<string, unknown>;
  const workspace = openWorkspace(record.jobRoot),
    config = workspace.config;
  const identity = {
    runtime: settings.runtime,
    provider: settings.provider?.trim() || null,
    model: settings.model?.trim() || null,
    roleOverrides: settings.roleOverrides ?? {},
    freeOnly: settings.freeOnly,
    executable: settings.executable?.trim() || null,
    endpoint: settings.endpoint?.trim() || null,
  };
  for (const [key, value] of Object.entries(identity))
    if (
      key in supplied &&
      canonicalJson(config.agent[key as keyof typeof identity]) !==
        canonicalJson(value)
    )
      throw new DeepError(
        "HOST_RESEARCH_SETTINGS_CHANGED",
        `Changing ${key} requires a new research job; paused jobs can change budgets and concurrency`,
      );
  const budgets = configuredBudgets(settings);
  const concurrency = settings.analysisWorkers ?? config.concurrency.analysis;
  const host = config.host;
  if (host === null)
    throw new DeepError("HOST_JOB_REQUIRED", "This is not a hosted job");
  writeConfig(
    record.jobRoot,
    ConfigSchema.parse({
      ...config,
      agent: {
        ...config.agent,
        budgets: { ...config.agent.budgets, ...budgets },
      },
      concurrency: {
        ...config.concurrency,
        analysis: config.agent.freeOnly
          ? Math.min(concurrency, settings.freeProviderConcurrency)
          : concurrency,
      },
      host: {
        ...host,
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
    }),
  );
}
