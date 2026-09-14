import { z } from "zod";
import {
  AnalysisRecordSchema,
  PatchRecordPayloadSchema,
  PlanRecordSchema,
  ReviewRecordSchema,
} from "../evidence/schemas.ts";
import type { AgentRoleName } from "../storage/types.ts";

/**
 * The payload a role must submit through its result tool. Host-owned identity and provenance fields
 * (unit id, snapshot id, baseline id, produced-by, attempt, input hash, contract versions) are stripped:
 * a model may describe what it found, it may never assert who it is or what it ran against.
 */
const AnalystPayloadSchema = AnalysisRecordSchema.omit({
  unitId: true,
  unitKind: true,
  sourceSnapshotId: true,
  baselineId: true,
  generatedOutputs: true,
  producedBy: true,
});

const ReviewerPayloadSchema = ReviewRecordSchema.omit({
  unitId: true,
  producedBy: true,
});

const ReconcilerPayloadSchema = PlanRecordSchema.omit({
  version: true,
  createdAt: true,
  producedBy: true,
});

const ImplementerPayloadSchema = PatchRecordPayloadSchema.omit({
  taskId: true,
  attempt: true,
  basePortRevision: true,
  inputHash: true,
  contractVersions: true,
  producedBy: true,
});

export type AnalystPayload = z.output<typeof AnalystPayloadSchema>;
export type ReviewerPayload = z.output<typeof ReviewerPayloadSchema>;
export type ReconcilerPayload = z.output<typeof ReconcilerPayloadSchema>;
export type ImplementerPayload = z.output<typeof ImplementerPayloadSchema>;

export interface RoleConfig {
  readonly role: AgentRoleName;
  readonly toolNames: readonly string[];
  readonly resultTool: string;
  readonly maxTurns: number;
  readonly resultSchema: z.ZodTypeAny;
  /** Denominator for the role's wall-clock budget, overridable per task. */
  readonly defaultTimeoutSeconds: number;
}

export const RESULT_TOOL_NAMES = {
  submit_analysis: "submit_analysis",
  submit_review: "submit_review",
  submit_plan: "submit_plan",
  propose_patch: "propose_patch",
} as const;

const COMMON_READ_TOOLS = [
  "read_source",
  "read_evidence",
  "list_unit_files",
] as const;

/**
 * Five fixed role configurations. No role gets a shell, and the only role with a write tool is the
 * implementer, whose `propose_patch` writes solely into the task's patch directory.
 */
export const ROLE_CONFIGS: Record<AgentRoleName, RoleConfig> = {
  analyst: {
    role: "analyst",
    toolNames: [
      ...COMMON_READ_TOOLS,
      "read_generated",
      "grep_source",
      "search_baseline",
      "get_converter_diagnostics",
      RESULT_TOOL_NAMES.submit_analysis,
    ],
    resultTool: RESULT_TOOL_NAMES.submit_analysis,
    maxTurns: 40,
    resultSchema: AnalystPayloadSchema,
    defaultTimeoutSeconds: 600,
  },
  risk_reviewer: {
    role: "risk_reviewer",
    toolNames: [
      ...COMMON_READ_TOOLS,
      "read_generated",
      "grep_source",
      RESULT_TOOL_NAMES.submit_review,
    ],
    resultTool: RESULT_TOOL_NAMES.submit_review,
    maxTurns: 30,
    resultSchema: ReviewerPayloadSchema,
    defaultTimeoutSeconds: 600,
  },
  reconciler: {
    role: "reconciler",
    toolNames: ["read_evidence", "read_source", RESULT_TOOL_NAMES.submit_plan],
    resultTool: RESULT_TOOL_NAMES.submit_plan,
    maxTurns: 20,
    resultSchema: ReconcilerPayloadSchema,
    defaultTimeoutSeconds: 900,
  },
  implementer: {
    role: "implementer",
    toolNames: [
      ...COMMON_READ_TOOLS,
      "read_generated",
      "grep_source",
      "search_baseline",
      RESULT_TOOL_NAMES.propose_patch,
    ],
    resultTool: RESULT_TOOL_NAMES.propose_patch,
    maxTurns: 60,
    resultSchema: ImplementerPayloadSchema,
    defaultTimeoutSeconds: 1_800,
  },
  patch_reviewer: {
    role: "patch_reviewer",
    toolNames: [
      "read_source",
      "read_generated",
      "read_evidence",
      RESULT_TOOL_NAMES.submit_review,
    ],
    resultTool: RESULT_TOOL_NAMES.submit_review,
    maxTurns: 30,
    resultSchema: ReviewerPayloadSchema,
    defaultTimeoutSeconds: 600,
  },
};

export function roleConfig(role: AgentRoleName): RoleConfig {
  const config = ROLE_CONFIGS[role];
  return {
    ...config,
    toolNames: [
      ...config.toolNames,
      "search_documentation",
      "read_documentation",
    ],
  };
}

export const WRITE_TOOL_NAMES: readonly string[] = [
  RESULT_TOOL_NAMES.propose_patch,
];
