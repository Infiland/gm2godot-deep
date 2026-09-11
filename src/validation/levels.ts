import { DeepError } from "../util/result.ts";
import type { Repo } from "../storage/repo.ts";
import { recordValidation, writeValidation } from "../evidence/store.ts";
import { ValidationResultSchema } from "../evidence/schemas.ts";
import type { ValidationResult as PersistedValidationResult } from "../evidence/schemas.ts";

/**
 * The vocabulary every validation check speaks, and the safety property that keeps the vocabulary
 * honest.
 *
 * A check state may only be written through the constructors below. `passed` is structurally
 * impossible to fake: {@link passedResult} refuses to build one without a command, an engine build
 * string and a numeric exit status, and {@link passedInProcessResult} refuses to build one without a
 * command and an exit status while making it impossible to attach an engine claim. A check that could
 * not run is `skipped`/`inconclusive` with a non-empty reason — never `passed`.
 */

export const CHECK_LEVELS = ["A", "B", "C", "D", "E"] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];

export const CHECK_STATES = ["passed", "failed", "skipped", "inconclusive"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/** Every constructor below throws this code rather than fabricating an execution. */
export const CHECK_NOT_EXECUTED = "GM2DEEP-CHECK-NOT-EXECUTED";

export interface ValidationResult {
  readonly level: CheckLevel;
  readonly checkId: string;
  readonly name: string;
  readonly state: CheckState;
  readonly command?: string;
  readonly engineVersion?: string;
  readonly inputRevision: string;
  readonly exitStatus?: number | null;
  readonly durationMs?: number;
  readonly logsPath?: string;
  readonly artifacts: readonly string[];
  readonly reason?: string;
}

/** A command + engine build + exit status, i.e. the proof a check actually executed. */
export interface ExecutedCheckEvidence {
  readonly command: string;
  readonly engineVersion: string;
  readonly exitStatus: number;
}

export interface CheckIdentity {
  readonly level: CheckLevel;
  readonly checkId: string;
  readonly name: string;
  readonly inputRevision: string;
}

export interface PassedCheckInput extends CheckIdentity {
  /** Exact argv that was executed, or, for an in-process check, its entry point identity. */
  readonly command: string;
  /** Engine build string that executed the check. Required: this constructor is engine-backed. */
  readonly engineVersion: string;
  readonly exitStatus: number;
  readonly durationMs?: number;
  readonly logsPath?: string;
  readonly artifacts?: readonly string[];
  readonly reason?: string;
}

export interface PassedInProcessCheckInput extends CheckIdentity {
  /** Entry point of the executed check, e.g. `in-process: src/validation/coverage.ts#checkCoverage`. */
  readonly command: string;
  readonly exitStatus: number;
  readonly durationMs?: number;
  readonly logsPath?: string;
  readonly artifacts?: readonly string[];
  readonly reason?: string;
}

export interface FailedCheckInput extends CheckIdentity {
  readonly command?: string;
  readonly engineVersion?: string;
  readonly exitStatus?: number | null;
  readonly durationMs?: number;
  readonly logsPath?: string;
  readonly artifacts?: readonly string[];
  readonly reason: string;
}

export interface NonPassedCheckInput extends CheckIdentity {
  readonly reason: string;
  readonly command?: string;
  readonly engineVersion?: string;
  readonly exitStatus?: number | null;
  readonly durationMs?: number;
  readonly logsPath?: string;
  readonly artifacts?: readonly string[];
}

function requiredText(value: unknown, field: string, why: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DeepError(CHECK_NOT_EXECUTED, `${why}; ${field} is required`, { field, observed: value ?? null });
  }
  return value;
}

function requiredExitStatus(value: unknown, why: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DeepError(CHECK_NOT_EXECUTED, `${why}; a numeric exitStatus is required`, {
      field: "exitStatus",
      observed: value ?? null,
    });
  }
  return value;
}

/**
 * A check that really executed and passed. Throws `GM2DEEP-CHECK-NOT-EXECUTED` unless a command, an
 * engine build string and a numeric exit status are all present.
 */
export function passedResult(input: PassedCheckInput): ValidationResult {
  const command = requiredText(input.command, "command", "a passed check must record the command that was executed");
  const engineVersion = requiredText(
    input.engineVersion,
    "engineVersion",
    "a passed engine-backed check must record the engine build string that ran it",
  );
  const exitStatus = requiredExitStatus(input.exitStatus, "a passed check must record the process exit status");
  return {
    level: input.level,
    checkId: input.checkId,
    name: input.name,
    state: "passed",
    command,
    engineVersion,
    exitStatus,
    inputRevision: input.inputRevision,
    artifacts: [...(input.artifacts ?? [])],
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.logsPath === undefined ? {} : { logsPath: input.logsPath }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

/**
 * A deterministic check that ran inside this process (level A coverage, the static half of level B).
 * It still has to record the entry point it executed and an exit status, and it deliberately has no
 * way to attach an engine version: an in-process check can never claim an engine ran it.
 */
export function passedInProcessResult(input: PassedInProcessCheckInput): ValidationResult {
  const command = requiredText(
    input.command,
    "command",
    "a passed check must record the entry point that was executed",
  );
  const exitStatus = requiredExitStatus(input.exitStatus, "a passed check must record the process exit status");
  return {
    level: input.level,
    checkId: input.checkId,
    name: input.name,
    state: "passed",
    command,
    exitStatus,
    inputRevision: input.inputRevision,
    artifacts: [...(input.artifacts ?? [])],
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.logsPath === undefined ? {} : { logsPath: input.logsPath }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

export function failedResult(input: FailedCheckInput): ValidationResult {
  const reason = requiredText(input.reason, "reason", "a failed check must record why it failed");
  return {
    level: input.level,
    checkId: input.checkId,
    name: input.name,
    state: "failed",
    inputRevision: input.inputRevision,
    artifacts: [...(input.artifacts ?? [])],
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.engineVersion === undefined ? {} : { engineVersion: input.engineVersion }),
    ...(input.exitStatus === undefined ? {} : { exitStatus: input.exitStatus }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.logsPath === undefined ? {} : { logsPath: input.logsPath }),
    reason,
  };
}

/** A check that could not run in this environment. Requires a non-empty reason. */
export function skippedResult(input: NonPassedCheckInput): ValidationResult {
  return nonPassedResult("skipped", input, "a skipped check must record why it was skipped");
}

/** A check that ran but could not reach a verdict. Requires a non-empty reason. */
export function inconclusiveResult(input: NonPassedCheckInput): ValidationResult {
  return nonPassedResult("inconclusive", input, "an inconclusive check must record why it is inconclusive");
}

function nonPassedResult(
  state: "skipped" | "inconclusive",
  input: NonPassedCheckInput,
  why: string,
): ValidationResult {
  const reason = requiredText(input.reason, "reason", why);
  return {
    level: input.level,
    checkId: input.checkId,
    name: input.name,
    state,
    inputRevision: input.inputRevision,
    artifacts: [...(input.artifacts ?? [])],
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.engineVersion === undefined ? {} : { engineVersion: input.engineVersion }),
    ...(input.exitStatus === undefined ? {} : { exitStatus: input.exitStatus }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.logsPath === undefined ? {} : { logsPath: input.logsPath }),
    reason,
  };
}

/**
 * The execution proof of a check, or `null` when the result does not carry one. Consumers that are
 * about to treat a check as authoritative use this instead of trusting the `state` string alone.
 */
export function executedEvidence(result: ValidationResult): ExecutedCheckEvidence | null {
  const { command, engineVersion, exitStatus } = result;
  if (typeof command !== "string" || command.length === 0) return null;
  if (typeof engineVersion !== "string" || engineVersion.length === 0) return null;
  if (typeof exitStatus !== "number" || !Number.isInteger(exitStatus)) return null;
  return { command, engineVersion, exitStatus };
}

/**
 * `null` when the result obeys the vocabulary, otherwise a description of the violation. `passed`
 * must carry a command and a numeric exit status, and `skipped`/`inconclusive`/`failed` must carry a
 * reason.
 */
export function checkStateViolation(result: ValidationResult): string | null {
  if (!CHECK_LEVELS.includes(result.level)) return `unknown check level ${JSON.stringify(result.level)}`;
  if (!CHECK_STATES.includes(result.state)) return `unknown check state ${JSON.stringify(result.state)}`;
  const reason = result.reason;
  const hasReason = typeof reason === "string" && reason.trim().length > 0;
  if (result.state === "passed") {
    if (typeof result.command !== "string" || result.command.trim().length === 0) {
      return `check ${result.checkId} is passed without a command`;
    }
    if (typeof result.exitStatus !== "number" || !Number.isInteger(result.exitStatus)) {
      return `check ${result.checkId} is passed without a numeric exit status`;
    }
    return null;
  }
  if (!hasReason) return `check ${result.checkId} is ${result.state} without a reason`;
  return null;
}

export interface ValidationSummary {
  readonly byLevel: Record<string, Record<CheckState, number>>;
  readonly totals: Record<CheckState, number>;
}

export function summarise(results: readonly ValidationResult[]): ValidationSummary {
  const byLevel: Record<string, Record<CheckState, number>> = {};
  for (const level of CHECK_LEVELS) byLevel[level] = { passed: 0, failed: 0, skipped: 0, inconclusive: 0 };
  const totals: Record<CheckState, number> = { passed: 0, failed: 0, skipped: 0, inconclusive: 0 };
  for (const result of results) {
    const bucket = byLevel[result.level];
    if (bucket !== undefined) bucket[result.state] += 1;
    totals[result.state] += 1;
  }
  return { byLevel, totals };
}

/**
 * Parse an unknown value as a check result: the persisted schema plus the state invariants. `null`
 * when the value is not a runner-produced check result — an agent's prose claim is `null` by
 * construction, so it can never be mistaken for evidence.
 */
export function parseCheckResult(value: unknown): ValidationResult | null {
  const parsed = ValidationResultSchema.safeParse(value);
  if (!parsed.success) return null;
  const result: ValidationResult = {
    level: parsed.data.level,
    checkId: parsed.data.checkId,
    name: parsed.data.name,
    state: parsed.data.state,
    inputRevision: parsed.data.inputRevision,
    artifacts: [...parsed.data.artifacts],
    ...(parsed.data.command === undefined ? {} : { command: parsed.data.command }),
    ...(parsed.data.engineVersion === undefined ? {} : { engineVersion: parsed.data.engineVersion }),
    ...(parsed.data.exitStatus === undefined ? {} : { exitStatus: parsed.data.exitStatus }),
    ...(parsed.data.durationMs === undefined ? {} : { durationMs: parsed.data.durationMs }),
    ...(parsed.data.logsPath === undefined ? {} : { logsPath: parsed.data.logsPath }),
    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
  };
  return checkStateViolation(result) === null ? result : null;
}

/** Where a validation result is persisted and recorded, when the caller wants both. */
export interface ValidationPersistence {
  /** `<workspace>/evidence/validation`. */
  readonly dir: string;
  readonly repo?: Repo | null;
  readonly taskId?: string | null;
}

export interface PersistedValidation {
  readonly checkId: string;
  readonly path: string;
  readonly sha256: string;
}

/** Strip a check result down to exactly the persisted schema, so a caller's richer object cannot leak. */
function persistedShape(result: ValidationResult): PersistedValidationResult {
  return {
    level: result.level,
    checkId: result.checkId,
    name: result.name,
    state: result.state,
    inputRevision: result.inputRevision,
    artifacts: [...result.artifacts],
    ...(result.command === undefined ? {} : { command: result.command }),
    ...(result.engineVersion === undefined ? {} : { engineVersion: result.engineVersion }),
    ...(result.exitStatus === undefined ? {} : { exitStatus: result.exitStatus }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.logsPath === undefined ? {} : { logsPath: result.logsPath }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

/**
 * The only supported way a check result reaches durable evidence: `writeValidation` writes the
 * artifact and `recordValidation` appends the row.
 */
export function persistValidation(
  persistence: ValidationPersistence,
  results: readonly ValidationResult[],
): readonly PersistedValidation[] {
  const written: PersistedValidation[] = [];
  for (const result of results) {
    const violation = checkStateViolation(result);
    if (violation !== null) {
      throw new DeepError(CHECK_NOT_EXECUTED, `refusing to persist an invalid check result: ${violation}`, {
        checkId: result.checkId,
      });
    }
    const shape = persistedShape(result);
    const artifact = writeValidation(persistence.dir, shape);
    if (persistence.repo !== null && persistence.repo !== undefined) {
      recordValidation(persistence.repo, shape, persistence.taskId ?? null);
    }
    written.push({ checkId: result.checkId, path: artifact.path, sha256: artifact.sha256 });
  }
  return written;
}
