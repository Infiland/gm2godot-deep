import { z } from "zod";

/** Bumped when the config shape changes incompatibly. */
export const CONFIG_VERSION = 1;

export const CONFIG_FILENAME = "deep-convert.config.json";

export type Platform = "windows" | "macos" | "linux";
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type AgentRuntimeId = "pi" | "mock" | "codex" | "claude" | "opencode";
export type SandboxBackendId =
  | "auto"
  | "sandbox-exec"
  | "docker"
  | "unsafe-local";

export const PlatformSchema = z.enum(["windows", "macos", "linux"]);
export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const AgentRuntimeSchema = z.enum([
  "pi",
  "mock",
  "codex",
  "claude",
  "opencode",
]);
export const SandboxBackendSchema = z.enum([
  "auto",
  "sandbox-exec",
  "docker",
  "unsafe-local",
]);
export const ReviewTriggerSchema = z.enum([
  "shared_interface",
  "high_risk",
  "contract_change",
]);

/** Platform default derived from the host OS, matching the plan's mapping. */
export function hostDefaultPlatform(): Platform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "windows";
}

const nonEmpty = z.string().min(1);

export const ConfigSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  source: z.strictObject({ path: nonEmpty }),
  workspace: z.strictObject({ path: nonEmpty }),
  gm2godot: z.strictObject({
    checkout: z.string().default(""),
    /** `null` means "auto-detect" (see `src/config/resolve.ts`). */
    python: z.string().nullable().default(null),
    expectedVersions: z.array(nonEmpty).min(1).default(["0.7.74"]),
    platform: PlatformSchema.default(hostDefaultPlatform()),
    groups: z.array(nonEmpty).default(["assets", "project", "wip"]),
    only: z.array(nonEmpty).default([]),
    allowPartial: z.boolean().default(true),
    timeoutSeconds: z.number().int().positive().max(86_400).default(900),
  }),
  host: z
    .strictObject({
      snapshotPath: nonEmpty,
      researchModelIdentity: z.string().nullable().default(null),
      freeProviderConcurrency: z.number().int().min(1).max(32).default(1),
      baselinePath: nonEmpty,
      maxSeconds: z.number().positive().nullable().default(null),
    })
    .nullable()
    .default(null),
  godot: z
    .strictObject({
      binary: z.string().nullable().default(null),
      expectedVersion: nonEmpty.default("4.7.2.stable.official.ed1daf0bf"),
      expectedVersionPrefix: nonEmpty.default("4.7.2"),
      bootFrames: z.number().int().min(0).max(10_000).default(0),
      timeoutSeconds: z.number().int().positive().max(3_600).default(120),
    })
    .prefault({}),
  agent: z
    .strictObject({
      runtime: AgentRuntimeSchema.default("mock"),
      provider: z.string().nullable().default(null),
      model: z.string().nullable().default(null),
      executable: z.string().nullable().default(null),
      endpoint: z.string().nullable().default(null),
      freeOnly: z.boolean().default(false),
      roleOverrides: z
        .record(
          z.string(),
          z.strictObject({
            runtime: AgentRuntimeSchema.optional(),
            provider: nonEmpty.optional(),
            model: nonEmpty.optional(),
          }),
        )
        .default({}),
      thinkingLevel: ThinkingLevelSchema.default("low"),
      maxTurnsPerTask: z.number().int().positive().max(1_000).default(40),
      taskTimeoutSeconds: z.number().int().positive().max(86_400).default(600),
      budgets: z
        .strictObject({
          perTaskTokens: z
            .number()
            .int()
            .positive()
            .nullable()
            .default(200_000),
          perTaskCostUsd: z.number().nonnegative().nullable().default(2),
          perRunTokens: z
            .number()
            .int()
            .positive()
            .nullable()
            .default(2_000_000),
          perRunCostUsd: z.number().nonnegative().nullable().default(20),
        })
        .prefault({}),
    })
    .prefault({}),
  concurrency: z
    .strictObject({
      analysis: z.number().int().positive().max(32).default(4),
      implementation: z.number().int().positive().max(32).default(1),
    })
    .prefault({}),
  sandbox: z
    .strictObject({
      backend: SandboxBackendSchema.default("auto"),
      dockerImage: nonEmpty.default("node:22-bookworm-slim"),
      cpus: z.number().positive().default(2),
      memoryMb: z.number().int().positive().default(2048),
      network: z.boolean().default(false),
      timeoutSeconds: z.number().int().positive().max(3_600).default(300),
    })
    .prefault({}),
  policy: z
    .strictObject({
      allowRemoteSourceUpload: z.boolean().default(false),
      allowUnsafeLocal: z.boolean().default(false),
      requireReviewFor: z
        .array(ReviewTriggerSchema)
        .default(["shared_interface", "high_risk"]),
      maxRepairAttempts: z.number().int().min(0).max(10).default(2),
      maxTaskAttempts: z.number().int().min(1).max(10).default(3),
    })
    .prefault({}),
  report: z
    .strictObject({
      includeSourceSnippets: z.boolean().default(false),
    })
    .prefault({}),
});

export type Config = z.output<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
