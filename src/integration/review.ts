import type { ContractRecord, PatchRecordPayload } from "../evidence/schemas.ts";
import { patchReviewerSystemPrompt } from "../agents/prompts.ts";
import { ROLE_CONFIGS, type ReviewerPayload } from "../agents/roles.ts";
import { ZERO_USAGE, type AgentRunRequest, type AgentRunResult, type AgentRuntime, type ToolContext, type ToolSpec, type Usage } from "../agents/runtime.ts";
import type { TaskRecord } from "../storage/types.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import type { ValidationResult } from "../validation/levels.ts";

const MAX_DIFF_CHARS = 60_000;

export interface PatchReviewVerdict {
  readonly verdict: "approved" | "rejected" | "unavailable";
  readonly reasons: readonly string[];
  readonly reviewerNotes: string;
  readonly usage: Usage;
}

export interface PatchReviewDeps {
  readonly runtime: AgentRuntime;
  readonly task: TaskRecord;
  readonly payload: PatchRecordPayload;
  /** The derived unified diff; the recorded file bodies remain authoritative. */
  readonly diff: string;
  readonly checks: readonly ValidationResult[];
  readonly workspaceRoots: AgentRunRequest["workspaceRoots"];
  readonly credentials: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** Contracts in effect, for the reviewer's prompt. */
  readonly contracts?: readonly ContractRecord[];
  /** Role tools, built by the caller; without them the reviewer can only judge the diff and checks. */
  readonly tools?: readonly ToolSpec[];
  readonly logger?: Logger | undefined;
  readonly recordPolicyDenial?: ToolContext["recordPolicyDenial"] | undefined;
}

function unavailable(reason: string, usage: Usage): PatchReviewVerdict {
  return { verdict: "unavailable", reasons: [reason], reviewerNotes: "", usage };
}

function renderChecks(checks: readonly ValidationResult[]): string {
  if (checks.length === 0) return "Recorded checks: none.";
  const lines = checks.map((check) => {
    const outcome = [
      check.state,
      check.exitStatus === undefined || check.exitStatus === null ? null : `exit=${check.exitStatus}`,
      check.engineVersion === undefined ? null : `engine=${check.engineVersion}`,
      check.reason === undefined ? null : `reason=${check.reason}`,
    ].filter((part): part is string => part !== null);
    return `- [level ${check.level}] ${check.checkId} (${check.name}): ${outcome.join(" ")}`;
  });
  return ["Recorded checks:", ...lines].join("\n");
}

function buildReviewUserPrompt(deps: PatchReviewDeps): string {
  const contractVersions = Object.entries(deps.payload.contractVersions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([concern, version]) => `${concern} v${version}`)
    .join(", ");
  const truncated = deps.diff.length > MAX_DIFF_CHARS;
  const diff = truncated ? `${deps.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at ${MAX_DIFF_CHARS} characters]` : deps.diff;
  return [
    `Review the patch proposed for task ${deps.task.id} (attempt ${deps.payload.attempt}, base port revision ${deps.payload.basePortRevision}).`,
    `Files changed: ${deps.payload.files.length === 0 ? "none" : deps.payload.files.map((file) => `${file.action} ${file.path}`).join(", ")}`,
    `Contracts in effect: ${contractVersions.length === 0 ? "none" : contractVersions}.`,
    `Implementer summary: ${deps.payload.summary.length === 0 ? "(none given)" : deps.payload.summary}`,
    renderChecks(deps.checks),
    "Unified diff (derived output; the recorded file bodies are authoritative):",
    diff.length === 0 ? "(no diff recorded)" : diff,
  ].join("\n\n");
}

/**
 * Run the `patch_reviewer` role through the injected runtime and reduce its review record to a verdict.
 *
 * A review that cannot run — aborted, timed out, failed, no result, or a payload this host cannot
 * validate — is reported as `unavailable`; it is never silently treated as approval. The verdict itself
 * only follows from the reviewer's record: a refuted challenge rejects the patch, anything else records
 * the reviewer's findings and approves. Check states, not this verdict, decide whether a check passed.
 */
export async function reviewPatch(deps: PatchReviewDeps): Promise<PatchReviewVerdict> {
  const config = ROLE_CONFIGS.patch_reviewer;
  const logger = deps.logger ?? silentLogger;
  const request: AgentRunRequest = {
    role: "patch_reviewer",
    taskId: deps.task.id,
    systemPrompt: patchReviewerSystemPrompt({ contracts: deps.contracts ?? [] }),
    userPrompt: buildReviewUserPrompt(deps),
    tools: deps.tools ?? [],
    workspaceRoots: deps.workspaceRoots,
    allowlist: deps.task.allowlist,
    resultSchema: config.resultSchema,
    maxTurns: config.maxTurns,
    timeoutSeconds: Math.min(deps.task.budgets.timeoutSeconds, config.defaultTimeoutSeconds),
    budgets: { tokens: deps.task.budgets.maxModelTokens, costUsd: deps.task.budgets.maxCostUsd },
    signal: deps.signal,
    credentials: deps.credentials,
    attempt: deps.payload.attempt,
    logger,
    recordPolicyDenial:
      deps.recordPolicyDenial ??
      ((detail) => logger.warn(`policy denial while reviewing ${deps.task.id}: ${detail.reason}`)),
  };

  let result: AgentRunResult;
  try {
    result = await deps.runtime.run(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(`GM2DEEP-REVIEW-UNAVAILABLE: patch_reviewer run threw: ${message}`, ZERO_USAGE);
  }

  if (result.outcome !== "completed" || result.result === undefined) {
    const reason = result.reason === undefined ? "" : ` (${result.reason})`;
    return unavailable(`GM2DEEP-REVIEW-UNAVAILABLE: patch_reviewer run ended as ${result.outcome}${reason}`, result.usage);
  }

  const parsed = config.resultSchema.safeParse(result.result);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    return unavailable(`GM2DEEP-REVIEW-UNAVAILABLE: patch_reviewer result failed validation: ${issues}`, result.usage);
  }

  // The role's own schema has already validated this value at runtime; the cast only carries the
  // role-owned payload type across the `z.ZodTypeAny` boundary of the runtime seam.
  const review = parsed.data as ReviewerPayload;
  const refuted = review.challenges.filter((challenge) => challenge.verdict === "refuted");
  const unverified = review.challenges.filter((challenge) => challenge.verdict === "unknown");
  const reasons = [
    ...refuted.map((challenge) => `refuted claim: ${challenge.claim}`),
    ...review.additionalHazards.map((hazard) => `additional hazard: ${hazard.description}`),
    ...review.missedDependencies.map((dependency) => `missed dependency: ${dependency.toUnitId} (${dependency.kind})`),
    ...unverified.map((challenge) => `unverified claim: ${challenge.claim}`),
  ];
  return {
    verdict: refuted.length > 0 ? "rejected" : "approved",
    reasons,
    reviewerNotes: review.reviewerNotes,
    usage: result.usage,
  };
}
