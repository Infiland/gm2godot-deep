import { z } from "zod";
import {
  BridgeInventorySchema,
  GmlApiEntrySchema,
} from "../adapters/gm2godot/bridge.ts";
import { AgentRuntimeSchema, ConfigSchema } from "../config/schema.ts";

export const PROTOCOL_VERSION = 1;
export const HostSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  gm2godotVersion: z.string().min(1),
  inventory: BridgeInventorySchema,
  gmlApiEntries: z.array(GmlApiEntrySchema),
});
export const HostSettingsSchema = z.object({
  runtime: AgentRuntimeSchema.default("mock"),
  provider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  executable: z.string().nullable().default(null),
  endpoint: z.string().nullable().default(null),
  roleOverrides: ConfigSchema.shape.agent
    .unwrap()
    .shape.roleOverrides.optional(),
  analysisWorkers: z.number().int().min(1).max(32).optional(),
  freeOnly: z.boolean().default(false),
  allowRemoteSourceUpload: z.boolean().default(false),
  freeProviderConcurrency: z.number().int().min(1).max(32).default(1),
  budgets: z
    .object({
      maxTokens: z.number().int().positive().nullable().optional(),
      maxCostUsd: z.number().nonnegative().nullable().optional(),
      maxSeconds: z
        .number()
        .positive()
        .max(86400 * 365)
        .nullable()
        .optional(),
      perTaskTokens: z.number().int().positive().nullable().optional(),
      perTaskCostUsd: z.number().nonnegative().nullable().optional(),
      perRunTokens: z.number().int().positive().nullable().optional(),
      perRunCostUsd: z.number().nonnegative().nullable().optional(),
    })
    .optional(),
  godotBinary: z.string().nullable().default(null),
});
export const ResearchParamsSchema = z.object({
  jobRoot: z.string().min(1),
  sourcePath: z.string().min(1),
  baselinePath: z.string().min(1),
  hostSnapshotPath: z.string().min(1),
  settings: HostSettingsSchema.prefault({}),
});
export const RequestSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: z.union([z.string(), z.number()]),
  method: z.enum([
    "capabilities",
    "research",
    "convert",
    "status",
    "pause",
    "resume",
    "cancel",
  ]),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type ResearchParams = z.output<typeof ResearchParamsSchema>;
export type HostRequest = z.output<typeof RequestSchema>;
export interface HostEvent {
  protocolVersion: 1;
  type: string;
  id?: string | number;
  jobId?: string;
  seq?: number;
  result?: unknown;
  error?: { code: string; message: string; recoverable: boolean };
}
