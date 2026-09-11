import { DeepError } from "../util/result.ts";
import { CHECK_NOT_EXECUTED, parseCheckResult } from "./levels.ts";
import type { CheckLevel, CheckState, ValidationResult } from "./levels.ts";
import type { AgentRunRequest, AgentRuntime } from "../agents/runtime.ts";

/**
 * The bounded repair loop: implement → validate → diagnose → repair → validate.
 *
 * Check state is written only by `src/validation/*`. {@link assertRunnerAuthoritative} rejects
 * anything that is not a runner-produced `ValidationResult`, so an implementer's prose ("the tests
 * pass now") can never turn a failing check into a passing one — it just becomes the next failure.
 *
 * When the repair budget is exhausted the outcome is `{state:"blocked"}` carrying the failing checks
 * as evidence; the loop never rewrites its way past a failure it cannot diagnose.
 */

export interface FailingCheck {
  readonly checkId: string;
  readonly level: CheckLevel;
  readonly name: string;
  readonly state: CheckState;
  readonly reason: string | null;
  readonly command: string | null;
  readonly logsPath: string | null;
  readonly artifacts: readonly string[];
}

export interface RepairDiagnosis {
  /** 1-based repair attempt this diagnosis feeds. */
  readonly attempt: number;
  readonly candidateWorkspace: string;
  readonly failingChecks: readonly FailingCheck[];
  readonly evidence: readonly ValidationResult[];
}

export interface RepairImplementContext {
  /** 0 for the initial implementation, `n` for repair attempt `n`. */
  readonly attempt: number;
  readonly diagnosis: RepairDiagnosis | null;
  readonly candidateWorkspace: string;
}

export interface RepairLoopDeps {
  /** Repairs permitted after the initial implementation. `0` means a single failing attempt blocks. */
  readonly maxRepairAttempts: number;
  /** Candidate workspace the implementer writes into and the checks run against. */
  readonly candidateWorkspace: string;
  readonly runtime: AgentRuntime;
  /** Builds the implementer request for this attempt, including the diagnosis prompt appendix. */
  readonly implementerRequest: (context: RepairImplementContext) => AgentRunRequest;
  /** Applies the implementer's result (patch publication) before the checks run. */
  readonly applyResult: (context: RepairImplementContext, result: unknown) => Promise<void>;
  /** Runs the acceptance/structural checks against the candidate. */
  readonly validate: (attempt: number) => Promise<readonly ValidationResult[]>;
  readonly onDiagnosis?: (diagnosis: RepairDiagnosis) => void;
  readonly signal?: AbortSignal;
}

export interface RepairOutcome {
  readonly state: "accepted" | "blocked";
  /** Repair attempts performed after the initial implementation. */
  readonly repairAttempts: number;
  readonly blockReason: string | null;
  /** The checks that justify the outcome: the failures when blocked, the passing set when accepted. */
  readonly evidence: readonly ValidationResult[];
  readonly diagnoses: readonly RepairDiagnosis[];
}

function toFailingCheck(check: ValidationResult): FailingCheck {
  return {
    checkId: check.checkId,
    level: check.level,
    name: check.name,
    state: check.state,
    reason: check.reason ?? null,
    command: check.command ?? null,
    logsPath: check.logsPath ?? null,
    artifacts: [...check.artifacts],
  };
}

/** Build the diagnosis record a repair attempt is driven from. */
export function diagnose(
  attempt: number,
  candidateWorkspace: string,
  failures: readonly ValidationResult[],
): RepairDiagnosis {
  if (failures.length === 0) {
    throw new DeepError("GM2DEEP-REPAIR-NO-FAILURE", "a repair diagnosis requires at least one failing check");
  }
  return {
    attempt,
    candidateWorkspace,
    failingChecks: failures.map(toFailingCheck),
    evidence: [...failures],
  };
}

/**
 * Render a diagnosis as the appendix of a repair prompt. It names the evidence and states plainly
 * that only the runner decides check state, so the model cannot be misled into "reporting success".
 */
export function describeDiagnosis(diagnosis: RepairDiagnosis): string {
  const lines: string[] = [
    `Repair attempt ${String(diagnosis.attempt)}. Candidate workspace: ${diagnosis.candidateWorkspace}`,
    "The checks below failed. Reproduce the failure with the recorded command, fix the cause in the candidate, then submit a new patch.",
  ];
  for (const check of diagnosis.failingChecks) {
    lines.push(
      [
        `- ${check.level}/${check.checkId} (${check.state}): ${check.name}`,
        check.reason === null ? "" : `    reason: ${check.reason}`,
        check.command === null ? "" : `    command: ${check.command}`,
        check.logsPath === null ? "" : `    log: ${check.logsPath}`,
        check.artifacts.length === 0 ? "" : `    artifacts: ${check.artifacts.join(", ")}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }
  lines.push(
    "A check becomes passed only when the runner records a command, an engine build and an exit status. Nothing you write changes a check state.",
  );
  return lines.join("\n");
}

/**
 * Only a runner-produced check result may set a check state. An agent-produced claim — prose, a
 * partial object, a "tests passed" summary — throws rather than being treated as evidence.
 */
export function assertRunnerAuthoritative(claim: unknown): ValidationResult {
  const parsed = parseCheckResult(claim);
  if (parsed !== null) return parsed;
  throw new DeepError(
    CHECK_NOT_EXECUTED,
    "only a runner-produced check result may set a check state; an agent claim is not evidence",
    { claim: typeof claim === "string" ? claim : (JSON.stringify(claim) ?? null) },
  );
}

export async function runRepairLoop(deps: RepairLoopDeps): Promise<RepairOutcome> {
  if (!Number.isInteger(deps.maxRepairAttempts) || deps.maxRepairAttempts < 0) {
    throw new DeepError(
      "GM2DEEP-REPAIR-BUDGET-INVALID",
      `maxRepairAttempts must be a non-negative integer, got ${String(deps.maxRepairAttempts)}`,
    );
  }
  const diagnoses: RepairDiagnosis[] = [];
  let lastFailures: readonly ValidationResult[] = [];

  for (let attempt = 0; ; attempt += 1) {
    if (deps.signal?.aborted === true) {
      return {
        state: "blocked",
        repairAttempts: attempt,
        blockReason: "the run was aborted before the implementer ran",
        evidence: lastFailures,
        diagnoses,
      };
    }
    const diagnosis = attempt === 0 ? null : (diagnoses[diagnoses.length - 1] ?? null);
    const context: RepairImplementContext = {
      attempt,
      diagnosis,
      candidateWorkspace: deps.candidateWorkspace,
    };
    const request = deps.implementerRequest(context);
    if (request.role !== "implementer") {
      throw new DeepError(
        "GM2DEEP-REPAIR-WRONG-ROLE",
        `the repair loop must run the implementer role, got ${request.role}`,
        { attempt },
      );
    }
    const runResult = await deps.runtime.run(request);
    if (runResult.outcome !== "completed") {
      return {
        state: "blocked",
        repairAttempts: attempt,
        blockReason: `implementer run ended with ${runResult.outcome}${runResult.reason === undefined ? "" : `: ${runResult.reason}`}`,
        evidence: lastFailures,
        diagnoses,
      };
    }
    await deps.applyResult(context, runResult.result);

    const checks = (await deps.validate(attempt)).map((check) => assertRunnerAuthoritative(check));
    const failures = checks.filter((check) => check.state !== "passed");
    if (failures.length === 0) {
      return { state: "accepted", repairAttempts: attempt, blockReason: null, evidence: checks, diagnoses };
    }
    lastFailures = failures;

    if (attempt >= deps.maxRepairAttempts) {
      return {
        state: "blocked",
        repairAttempts: attempt,
        blockReason: `repair budget exhausted after ${String(attempt)} repair attempt(s); failing checks: ${failures.map((check) => check.checkId).join(", ")}`,
        evidence: failures,
        diagnoses,
      };
    }
    const next = diagnose(attempt + 1, deps.candidateWorkspace, failures);
    diagnoses.push(next);
    deps.onDiagnosis?.(next);
  }
}
