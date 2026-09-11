export const TASK_STATES = [
  "DISCOVERED",
  "ANALYZED",
  "PLANNED",
  "READY",
  "RUNNING",
  "IMPLEMENTED",
  "VALIDATING",
  "ACCEPTED",
  "REPAIR_REQUIRED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = ["ACCEPTED", "BLOCKED", "FAILED", "CANCELLED"];

export type AgentRoleName = "analyst" | "risk_reviewer" | "reconciler" | "implementer" | "patch_reviewer";

export type UnitStrategy = "retain_generated" | "repair_generated" | "replace_component" | "blocked";

export type RiskLevel = "low" | "medium" | "high";

export interface Allowlist {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

export interface TaskBudgets {
  readonly maxAttempts: number;
  readonly maxModelTokens: number | null;
  readonly maxCostUsd: number | null;
  readonly timeoutSeconds: number;
}

export interface TaskRecord {
  readonly id: string;
  readonly unitIds: readonly string[];
  readonly role: AgentRoleName;
  readonly state: TaskState;
  readonly strategy: UnitStrategy;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly allowlist: Allowlist;
  readonly dependsOn: readonly string[];
  readonly contractVersions: Readonly<Record<string, number>>;
  readonly inputHash: string;
  readonly acceptanceCheckIds: readonly string[];
  readonly reviewRequired: boolean;
  readonly budgets: TaskBudgets;
  readonly blockReason: string | null;
  readonly publishedRevision: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UnitRecord {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly analysisRequired: boolean;
  readonly deterministic: boolean;
  readonly state: TaskState;
  readonly strategy: UnitStrategy | null;
  readonly riskLevel: RiskLevel | null;
  readonly risk: unknown;
  readonly groupId: string | null;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly updatedAt: string;
}

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly reasons: readonly string[];
}

export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
  readonly reported: boolean;
}

export interface RunRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly throughPhase: string;
  readonly phase: string;
  readonly status: string;
  readonly execute: boolean;
  readonly detail: unknown;
}

export interface PatchRecord {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly sha256: string;
  readonly path: string;
  readonly diffPath: string;
  readonly basePortRevision: number;
  readonly state: string;
  readonly createdAt: string;
}

export interface IntegrationRecord {
  readonly id: string;
  readonly taskId: string;
  readonly patchSha256: string;
  readonly basePortRevision: number;
  readonly publishedRevision: number;
  readonly idempotencyKey: string;
  readonly files: readonly string[];
  readonly createdAt: string;
}

export interface ValidationRow {
  readonly checkId: string;
  readonly taskId: string | null;
  readonly level: string;
  readonly name: string;
  readonly state: string;
  readonly command: string | null;
  readonly engineVersion: string | null;
  readonly inputRevision: string;
  readonly exitStatus: number | null;
  readonly durationMs: number | null;
  readonly logsPath: string | null;
  readonly artifacts: readonly string[];
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface LeaseRecord {
  readonly taskId: string;
  readonly owner: string | null;
  readonly acquiredAt: string | null;
  readonly expiresAt: string | null;
}
