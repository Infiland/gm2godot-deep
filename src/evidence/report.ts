/**
 * The evidence report.
 *
 * Every number in this file is read from a stored artifact (`evidence/**`) or a database row; nothing
 * is estimated, rounded up, or inferred from a process exit alone. Where a value cannot be read the
 * report says so — `readErrors` names the artifact and the failure — instead of substituting a zero.
 *
 * Three numbers are reported separately and are never combined: **file coverage** (was every file
 * accounted for), **test coverage** (how many applicable checks passed) and **behavioral
 * verification** (how many behavioural checks ran and passed). A single "compatibility percentage"
 * would be a claim none of those three numbers supports.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "../util/log.ts";
import { packageVersion } from "../util/package.ts";
import { nowIso } from "../util/ids.ts";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "../util/json.ts";
import type { Repo } from "../storage/repo.ts";
import type { IntegrationRecord, PatchRecord, TaskRecord, UnitRecord, ValidationRow } from "../storage/types.ts";
import type { Workspace } from "../workspaces/workspace.ts";
import {
  BASELINE_EVIDENCE_FILENAME,
  readBaselineEvidence,
  type BaselineEvidence,
} from "../adapters/gm2godot/adapter.ts";
import { selectSandboxBackend } from "../sandbox/select.ts";
import {
  INVENTORY_FILENAME,
  SNAPSHOT_FILENAME,
  readInventory,
  readSnapshotRecord,
  type InventoryRecord,
} from "../indexing/inventory.ts";
import { latestPlanVersion, listAnalyses, listContracts, readPlan } from "./store.ts";
import {
  PatchRecordPayloadSchema,
  ReviewRecordSchema,
  type AnalysisRecord,
  type ContractRecord,
  type PatchRecordPayload,
  type PlanRecord,
  type ProducedBy,
  type ReviewRecord,
} from "./schemas.ts";
import { isDisposition, type Disposition } from "../validation/coverage.ts";
import { DeepError } from "../util/result.ts";

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_JSON_FILENAME = "report.json";
export const REPORT_MARKDOWN_FILENAME = "report.md";

/** Rendered when a check ran through the explicit no-isolation backend. */
export const UNSAFE_LOCAL_BANNER = "UNSAFE LOCAL MODE";
export const UNSAFE_LOCAL_BACKEND = "unsafe-local";

/** These two sentences are reproduced verbatim in the markdown; they bound what the evidence proves. */
export const EVIDENCE_LIMITATION =
  "evidence validation prevents fabricated or stale file references but does not prove a claim true";
export const SYNTHETIC_LIMITATION = "a synthetic expectation is not an observation of the original runtime";

/**
 * `task_events.kind` and `patches.state` vocabulary, exactly as the scheduler records it. The report
 * never pattern-matches event names: an unrecognised kind would be a schema drift, not a rejection.
 */
export const POLICY_DENIED_KIND = "policy_denied";
export const REVIEW_EVENT_KIND = "review";
export const INTEGRATION_EVENT_KIND = "integration";
export const FAILURE_EVENT_KINDS: readonly string[] = ["failure", "check_failed", "analysis_blocked", "budget_exceeded", "repair"];
export const PATCH_STATE_PUBLISHED = "published";
export const PATCH_STATE_REJECTED = "rejected";

export interface ReportDeps {
  readonly workspace: Workspace;
  readonly repo: Repo;
  readonly logger: Logger;
}

export interface ReadError {
  readonly path: string;
  readonly error: string;
}

export interface ReportProvenance {
  readonly sourceSnapshotId: string | null;
  readonly baselineId: string | null;
  readonly baseline: BaselineEvidence | null;
  readonly snapshotEntryCount: number | null;
  readonly snapshotExcludedCount: number | null;
}

export interface ReportVersions {
  readonly deepConvert: string;
  readonly node: string;
  readonly gm2godotVersion: string | null;
  readonly gm2godotCommit: string | null;
  readonly gm2godotCheckout: string | null;
  readonly python: string | null;
  readonly pythonVersion: string | null;
  readonly engineExpected: string;
  readonly engineObserved: readonly string[];
  readonly agentArtifacts: readonly AgentArtifactProvenance[];
}

export interface AgentArtifactProvenance {
  readonly kind: "analysis" | "review" | "contract" | "plan" | "patch";
  readonly path: string;
  readonly unitId: string | null;
  readonly runtime: string;
  readonly simulated: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly costUsd: number;
    readonly reported: boolean;
  };
}

export interface ReportAdapters {
  /** `pi (real, provider=… model=…)` / `mock (deterministic, no model exercised)`, one per distinct runtime. */
  readonly runtimeLines: readonly string[];
  readonly sandboxConfigured: string;
  readonly sandboxResolved: string;
  readonly sandboxAvailable: boolean;
  readonly sandboxDetail: string;
  readonly checksBySandbox: readonly { readonly checkId: string; readonly backend: string | null }[];
  readonly unsafeLocalChecks: readonly string[];
  readonly unsafeLocalBanner: string | null;
}

export interface FileDisposition {
  readonly path: string;
  readonly classification: string;
  readonly disposition: string;
  readonly basis: string;
}

export interface UnitDisposition {
  readonly unitId: string;
  readonly kind: string;
  readonly name: string;
  readonly disposition: string;
  readonly basis: string;
}

export interface ReportDispositions {
  readonly units: readonly UnitDisposition[];
  readonly files: readonly FileDisposition[];
  readonly counts: Readonly<Record<string, number>>;
}

export interface AcceptedChange {
  readonly patchId: string | null;
  readonly taskId: string;
  readonly patchSha256: string;
  readonly basePortRevision: number | null;
  readonly publishedRevision: number;
  readonly integrationId: string;
  readonly files: readonly string[];
  readonly reviewVerdict: string | null;
  readonly createdAt: string;
}

export interface RejectedChange {
  readonly patchId: string;
  readonly taskId: string;
  readonly patchSha256: string;
  readonly state: string;
  readonly reviewVerdict: string | null;
  readonly reasons: readonly string[];
  readonly createdAt: string;
}

export interface PolicyDenial {
  readonly taskId: string;
  readonly at: string;
  readonly detail: unknown;
}

export interface ReportChanges {
  readonly accepted: readonly AcceptedChange[];
  readonly rejected: readonly RejectedChange[];
  readonly policyDenials: readonly PolicyDenial[];
}

export interface ReportValidation {
  readonly checks: readonly ValidationRow[];
  readonly byLevel: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly totals: Readonly<Record<string, number>>;
}

export interface BlockerEntry {
  readonly scope: "unit" | "task" | "plan";
  readonly id: string;
  readonly text: string;
  readonly evidence: readonly string[];
}

export interface UncertaintyEntry {
  readonly unitId: string;
  readonly text: string;
  readonly basis: string;
}

export interface UnresolvedEntry {
  readonly unitId: string;
  readonly symbol: string;
  readonly reason: string;
}

export interface SkippedCheck {
  readonly checkId: string;
  readonly level: string;
  readonly name: string;
  readonly reason: string;
}

export interface SummaryNumber {
  readonly label: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly percent: number | null;
  readonly basis: string;
}

export interface ReportUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
  readonly reported: boolean;
}

export interface ReportJson {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly workspaceRoot: string;
  readonly provenance: ReportProvenance;
  readonly versions: ReportVersions;
  readonly adapters: ReportAdapters;
  readonly dispositions: ReportDispositions;
  readonly changes: ReportChanges;
  readonly validation: ReportValidation;
  readonly blockers: readonly BlockerEntry[];
  readonly uncertainties: readonly UncertaintyEntry[];
  readonly unresolvedReferences: readonly UnresolvedEntry[];
  readonly skippedChecks: readonly SkippedCheck[];
  readonly usage: {
    readonly artifacts: ReportUsage;
    readonly latestRunId: string | null;
    readonly latestRun: ReportUsage | null;
    readonly tasks: readonly { readonly taskId: string; readonly usage: ReportUsage }[];
  };
  readonly counts: {
    readonly unitsByState: Readonly<Record<string, number>>;
    readonly tasksByState: Readonly<Record<string, number>>;
    readonly portRevision: number;
    readonly portRevisionCount: number;
  };
  readonly summary: {
    readonly fileCoverage: SummaryNumber;
    readonly testCoverage: SummaryNumber;
    readonly behavioralVerification: SummaryNumber;
  };
  readonly readErrors: readonly ReadError[];
}

/** A `task_events` row, as `Repo.listEvents` returns it. */
export interface TaskEventRecord {
  readonly at: string;
  readonly kind: string;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly attempt: number | null;
  readonly detail: unknown;
}

/**
 * `task_events.detail` is stored JSON written by the scheduler. It is parsed once, here, at the
 * boundary; the named output type is what the rest of the file consumes.
 */
const TaskEventDetailSchema = z.looseObject({
  reason: z.string().optional(),
  reasons: z.array(z.string()).optional(),
  message: z.string().optional(),
  detail: z.string().optional(),
  verdict: z.string().optional(),
  state: z.string().optional(),
  tool: z.string().optional(),
  path: z.string().optional(),
  checkId: z.string().optional(),
  level: z.string().optional(),
  scope: z.string().optional(),
  review: z
    .looseObject({ verdict: z.string().optional(), reasons: z.array(z.string()).optional(), reviewerNotes: z.string().optional() })
    .optional(),
});
export type TaskEventDetail = z.output<typeof TaskEventDetailSchema>;

/** Events whose `detail` could not be parsed are reported with their raw JSON, never dropped. */
export function parseTaskEventDetail(detail: unknown): TaskEventDetail | null {
  const parsed = TaskEventDetailSchema.safeParse(detail);
  return parsed.success ? parsed.data : null;
}

function reasonText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  const parsed = parseTaskEventDetail(detail);
  if (parsed === null) return JSON.stringify(detail ?? null);
  if (parsed.reasons !== undefined && parsed.reasons.length > 0) return parsed.reasons.join("; ");
  for (const value of [parsed.reason, parsed.message, parsed.detail]) {
    if (value !== undefined && value.length > 0) return value;
  }
  return JSON.stringify(detail);
}

interface EventReviewDetail {
  readonly verdict: string | null;
  readonly reasons: readonly string[];
  readonly state: string | null;
}

/** What the `review` and `integration` events say, without guessing at any other event kind. */
function reviewDetail(event: TaskEventRecord): EventReviewDetail | null {
  if (event.kind !== REVIEW_EVENT_KIND && event.kind !== INTEGRATION_EVENT_KIND) return null;
  const parsed = parseTaskEventDetail(event.detail);
  if (parsed === null) return null;
  const nested = parsed.review;
  return {
    verdict: parsed.verdict ?? nested?.verdict ?? null,
    reasons: parsed.reasons !== undefined && parsed.reasons.length > 0 ? parsed.reasons : (nested?.reasons ?? []),
    state: parsed.state ?? null,
  };
}

/** Reasons a rejected patch carries, each one labelled with the event that recorded it. */
function rejectionReasons(events: readonly TaskEventRecord[]): { readonly reasons: readonly string[]; readonly verdict: string | null } {
  const reasons: string[] = [];
  let verdict: string | null = null;
  for (const event of events) {
    const review = reviewDetail(event);
    if (review !== null) {
      if (review.verdict !== null) verdict = review.verdict;
      const rejected =
        event.kind === INTEGRATION_EVENT_KIND
          ? review.state !== "accepted"
          : review.verdict !== null && review.verdict !== "approved";
      if (rejected) {
        for (const reason of review.reasons) reasons.push(`${event.at} ${event.kind}: ${reason}`);
      }
      continue;
    }
    if (event.kind === POLICY_DENIED_KIND || FAILURE_EVENT_KINDS.includes(event.kind)) {
      reasons.push(`${event.at} ${event.kind}: ${reasonText(event.detail)}`);
    }
  }
  return { reasons, verdict };
}

function percentOf(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

/**
 * The last recorded reason a task is BLOCKED/FAILED: the newest `failure`, `check_failed`,
 * `analysis_blocked`, `budget_exceeded`, `repair` or rejected-`integration` event. `null` when the
 * events carry none — the caller then says so rather than inventing a reason.
 */
export function recordedFailureReason(events: readonly TaskEventRecord[]): string | null {
  for (const event of events.slice().reverse()) {
    const review = reviewDetail(event);
    if (review !== null && review.state === "rejected") return reasonText(event.detail);
    if (FAILURE_EVENT_KINDS.includes(event.kind)) return reasonText(event.detail);
  }
  return null;
}

/** Read an artifact, recording the failure instead of hiding it behind a default value. */
function attempt<T>(path: string, errors: ReadError[], read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    errors.push({ path, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function sumUsage(records: readonly { readonly usage: ReportUsage }[]): ReportUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUsd = 0;
  for (const record of records) {
    input += record.usage.input;
    output += record.usage.output;
    cacheRead += record.usage.cacheRead;
    cacheWrite += record.usage.cacheWrite;
    costUsd += record.usage.costUsd;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    reported: records.length > 0 && records.every((record) => record.usage.reported),
  };
}

/** The exact runtime line the plan requires, derived only from recorded `producedBy`. */
export function runtimeLine(record: { runtime: string; simulated: boolean; provider: string | null; model: string | null }): string {
  if (record.runtime === "mock") return "mock (deterministic, no model exercised)";
  const provider = record.provider ?? "unspecified";
  const model = record.model ?? "unspecified";
  if (record.simulated) return `pi (simulated, provider=${provider} model=${model})`;
  return `pi (real, provider=${provider} model=${model})`;
}

function reviewRecords(analysesDir: string, errors: ReadError[]): ReviewRecord[] {
  if (!existsSync(analysesDir)) return [];
  const records: ReviewRecord[] = [];
  for (const name of readdirSync(analysesDir).sort()) {
    if (!name.endsWith(".review.json")) continue;
    const path = join(analysesDir, name);
    const parsed = attempt(path, errors, () => ReviewRecordSchema.parse(readJsonFile(path)));
    if (parsed !== null) records.push(parsed);
  }
  return records;
}

function patchPayloads(repo: Repo, errors: ReadError[]): { readonly patch: PatchRecord; readonly payload: PatchRecordPayload | null }[] {
  return repo.listPatches().map((patch) => ({
    patch,
    payload: existsSync(patch.path)
      ? attempt(patch.path, errors, () => PatchRecordPayloadSchema.parse(readJsonFile(patch.path)))
      : null,
  }));
}

/** Sandbox backend named by a recorded check, when the check recorded one. */
export function sandboxBackendOf(row: { command: string | null; reason: string | null; logsPath: string | null; artifacts: readonly string[] }): string | null {
  const haystack = [row.command ?? "", row.reason ?? "", row.logsPath ?? "", ...row.artifacts].join("\n");
  if (haystack.includes(UNSAFE_LOCAL_BACKEND)) return UNSAFE_LOCAL_BACKEND;
  if (haystack.includes("sandbox-exec")) return "sandbox-exec";
  if (/\bdocker\b/.test(haystack)) return "docker";
  return null;
}

interface UnitInputs {
  readonly unit: UnitRecord;
  readonly analysis: AnalysisRecord | null;
  readonly published: boolean;
}

/**
 * The disposition vocabulary is owned by the level-A coverage check; the report re-derives the same
 * value from the same stored inputs (unit membership + analysis strategy + published patches) so the
 * two numbers cannot drift in meaning.
 */
function unitDisposition(inputs: UnitInputs): { disposition: Disposition | "deterministic_only" | "unaccounted"; basis: string } {
  const { unit, analysis, published } = inputs;
  if (analysis === null) {
    if (!unit.analysisRequired) return { disposition: "deterministic_only", basis: "unit kind requires no analysis" };
    return { disposition: "unaccounted", basis: "no analysis record stored for a unit that requires analysis" };
  }
  switch (analysis.strategy) {
    case "retain_generated":
      return { disposition: "retained", basis: "analysis strategy retain_generated" };
    case "blocked":
      return { disposition: "blocked", basis: "analysis strategy blocked" };
    case "replace_component":
      return published
        ? { disposition: "replaced", basis: "analysis strategy replace_component with a published patch" }
        : { disposition: "analyzed", basis: "analysis strategy replace_component, no patch published yet" };
    case "repair_generated":
      return published
        ? { disposition: "repaired", basis: "analysis strategy repair_generated with a published patch" }
        : { disposition: "analyzed", basis: "analysis strategy repair_generated, no patch published yet" };
  }
}

const DISPOSITION_PRIORITY: readonly string[] = ["blocked", "replaced", "repaired", "retained", "analyzed", "deterministic_only"];

export interface ReportBuildResult {
  readonly json: ReportJson;
  readonly markdown: string;
}

export async function buildReport(deps: ReportDeps): Promise<ReportBuildResult> {
  const { workspace, repo } = deps;
  const paths = workspace.paths;
  const readErrors: ReadError[] = [];

  const snapshotPath = join(paths.evidenceInventory, SNAPSHOT_FILENAME);
  const snapshot = existsSync(snapshotPath)
    ? attempt(snapshotPath, readErrors, () => readSnapshotRecord(paths.evidenceInventory))
    : null;

  const inventoryPath = join(paths.evidenceInventory, INVENTORY_FILENAME);
  const inventory: InventoryRecord | null = existsSync(inventoryPath)
    ? attempt(inventoryPath, readErrors, () => readInventory(paths.evidenceInventory))
    : null;

  const baselinePath = join(paths.evidenceInventory, BASELINE_EVIDENCE_FILENAME);
  const baseline: BaselineEvidence | null = existsSync(baselinePath)
    ? attempt(baselinePath, readErrors, () => readBaselineEvidence(paths.evidenceInventory))
    : null;

  const analyses: AnalysisRecord[] = existsSync(paths.evidenceAnalyses)
    ? (attempt(paths.evidenceAnalyses, readErrors, () => listAnalyses(paths.evidenceAnalyses)) ?? [])
    : [];
  const reviews = reviewRecords(paths.evidenceAnalyses, readErrors);
  const contracts: ContractRecord[] = existsSync(paths.evidenceContracts)
    ? (attempt(paths.evidenceContracts, readErrors, () => listContracts(paths.evidenceContracts)) ?? [])
    : [];
  const planVersion = attempt(paths.evidencePlans, readErrors, () => latestPlanVersion(paths.evidencePlans));
  const plan: PlanRecord | null =
    planVersion === null || planVersion === undefined
      ? null
      : attempt(paths.evidencePlans, readErrors, () => readPlan(paths.evidencePlans, planVersion));

  const units = repo.listUnits();
  const tasks = repo.listTasks();
  const patches = repo.listPatches();
  const payloads = patchPayloads(repo, readErrors);
  const integrations = repo.listIntegrations();
  const validationRows = repo.listValidation();
  const eventsByTask = new Map<string, TaskEventRecord[]>();
  for (const task of tasks) eventsByTask.set(task.id, attempt(`task_events:${task.id}`, readErrors, () => repo.listEvents(task.id)) ?? []);

  const analysisByUnit = new Map(analyses.map((record) => [record.unitId, record]));
  const publishedTaskIds = new Set(integrations.map((integration) => integration.taskId));

  // ------------------------------------------------------------ versions

  const agentArtifacts: AgentArtifactProvenance[] = [];
  const pushProvenance = (
    kind: AgentArtifactProvenance["kind"],
    path: string,
    unitId: string | null,
    producedBy: ProducedBy | undefined,
  ): void => {
    if (producedBy === undefined) return;
    agentArtifacts.push({
      kind,
      path,
      unitId,
      runtime: producedBy.runtime,
      simulated: producedBy.simulated,
      provider: producedBy.provider ?? null,
      model: producedBy.model ?? null,
      promptVersion: producedBy.promptVersion,
      usage: { ...producedBy.usage },
    });
  };
  for (const record of analyses) {
    pushProvenance("analysis", paths.evidenceAnalyses, record.unitId, record.producedBy);
  }
  for (const record of reviews) pushProvenance("review", paths.evidenceAnalyses, record.unitId, record.producedBy);
  for (const record of contracts) pushProvenance("contract", paths.evidenceContracts, null, record.producedBy);
  if (plan !== null) pushProvenance("plan", paths.evidencePlans, null, plan.producedBy);
  for (const entry of payloads) {
    if (entry.payload === null) continue;
    pushProvenance("patch", entry.patch.path, entry.patch.taskId, entry.payload.producedBy);
  }
  agentArtifacts.sort((a, b) => (a.path === b.path ? a.kind.localeCompare(b.kind) : a.path.localeCompare(b.path)));

  const engineObserved = [...new Set(validationRows.map((row) => row.engineVersion).filter((value): value is string => value !== null))].sort();

  // ------------------------------------------------------------ sandbox

  let sandboxResolved = "none";
  let sandboxAvailable = false;
  let sandboxDetail = "isolation-requiring operations will fail closed";
  try {
    const backend = await selectSandboxBackend(workspace.config);
    sandboxResolved = backend.id;
    sandboxAvailable = true;
    sandboxDetail = `${backend.id} (available)`;
  } catch (error) {
    sandboxDetail = error instanceof DeepError ? `${error.code}: ${error.message}` : String(error);
  }

  const checksBySandbox = validationRows.map((row) => ({
    checkId: row.checkId,
    backend: sandboxBackendOf({ command: row.command, reason: row.reason, logsPath: row.logsPath, artifacts: row.artifacts }),
  }));
  const unsafeLocalChecks = checksBySandbox.filter((entry) => entry.backend === UNSAFE_LOCAL_BACKEND).map((entry) => entry.checkId);
  const unsafeLocal = sandboxResolved === UNSAFE_LOCAL_BACKEND || unsafeLocalChecks.length > 0;

  const runtimeKeys = new Map<string, AgentArtifactProvenance>();
  for (const artifact of agentArtifacts) {
    const key = `${artifact.runtime}|${String(artifact.simulated)}|${artifact.provider ?? ""}|${artifact.model ?? ""}`;
    if (!runtimeKeys.has(key)) runtimeKeys.set(key, artifact);
  }
  const runtimeLines = [...runtimeKeys.values()]
    .map((artifact) =>
      runtimeLine({
        runtime: artifact.runtime,
        simulated: artifact.simulated,
        provider: artifact.provider,
        model: artifact.model,
      }),
    )
    .sort();

  // -------------------------------------------------------- dispositions

  const unitDispositions: UnitDisposition[] = units
    .map((unit) => {
      const analysis = analysisByUnit.get(unit.id) ?? null;
      const published = analysis !== null && tasks.some((task) => task.unitIds.includes(unit.id) && publishedTaskIds.has(task.id));
      const decided = unitDisposition({ unit, analysis, published });
      return { unitId: unit.id, kind: unit.kind, name: unit.name, disposition: decided.disposition, basis: decided.basis };
    })
    .sort((a, b) => a.unitId.localeCompare(b.unitId));
  const unitDispositionById = new Map(unitDispositions.map((entry) => [entry.unitId, entry]));

  const unitsByPath = new Map<string, string[]>();
  for (const unit of inventory?.units ?? []) {
    for (const path of unit.sourcePaths) {
      const existing = unitsByPath.get(path);
      if (existing === undefined) unitsByPath.set(path, [unit.id]);
      else existing.push(unit.id);
    }
  }

  const fileDispositions: FileDisposition[] = (inventory?.files ?? []).map((file) => {
    if (file.classification === "excluded") {
      return {
        path: file.path,
        classification: file.classification,
        disposition: `excluded(${file.classificationReason})`,
        basis: "file excluded from the snapshot",
      };
    }
    const owners = (unitsByPath.get(file.path) ?? []).slice().sort();
    const candidates = owners
      .map((unitId) => unitDispositionById.get(unitId))
      .filter((entry): entry is UnitDisposition => entry !== undefined && entry.disposition !== "unaccounted");
    if (candidates.length === 0) {
      return {
        path: file.path,
        classification: file.classification,
        disposition: "unaccounted",
        basis: owners.length === 0 ? "file belongs to no unit" : `units ${owners.join(", ")} carry no disposition`,
      };
    }
    const ranked = candidates
      .slice()
      .sort((a, b) => {
        const priority = DISPOSITION_PRIORITY.indexOf(a.disposition) - DISPOSITION_PRIORITY.indexOf(b.disposition);
        return priority !== 0 ? priority : a.unitId.localeCompare(b.unitId);
      })[0] as UnitDisposition;
    return {
      path: file.path,
      classification: file.classification,
      disposition: ranked.disposition,
      basis: `via unit ${ranked.unitId} (${ranked.basis})`,
    };
  });
  fileDispositions.sort((a, b) => a.path.localeCompare(b.path));

  const dispositionCounts: Record<string, number> = {};
  for (const entry of fileDispositions) {
    const key = entry.disposition.startsWith("excluded(") ? "excluded" : entry.disposition;
    dispositionCounts[key] = (dispositionCounts[key] ?? 0) + 1;
  }

  // ----------------------------------------------------------- changes

  const accepted: AcceptedChange[] = integrations
    .map((integration: IntegrationRecord) => {
      const patch = patches.find((candidate) => candidate.taskId === integration.taskId && candidate.sha256 === integration.patchSha256) ?? null;
      const events = eventsByTask.get(integration.taskId) ?? [];
      const review = rejectionReasons(events);
      return {
        patchId: patch?.id ?? null,
        taskId: integration.taskId,
        patchSha256: integration.patchSha256,
        basePortRevision: patch?.basePortRevision ?? integration.basePortRevision,
        publishedRevision: integration.publishedRevision,
        integrationId: integration.id,
        files: [...integration.files],
        reviewVerdict: review.verdict,
        createdAt: integration.createdAt,
      };
    })
    .sort((a, b) => a.publishedRevision - b.publishedRevision);

  const rejected: RejectedChange[] = patches
    .filter((patch) => patch.state === PATCH_STATE_REJECTED || !integrations.some((integration) => integration.taskId === patch.taskId && integration.patchSha256 === patch.sha256))
    .map((patch) => {
      const events = eventsByTask.get(patch.taskId) ?? [];
      const recorded = rejectionReasons(events);
      return {
        patchId: patch.id,
        taskId: patch.taskId,
        patchSha256: patch.sha256,
        state: patch.state,
        reviewVerdict: recorded.verdict,
        reasons: recorded.reasons,
        createdAt: patch.createdAt,
      };
    })
    .sort((a, b) => a.patchId.localeCompare(b.patchId));

  const policyDenials: PolicyDenial[] = [];
  for (const task of tasks) {
    for (const event of eventsByTask.get(task.id) ?? []) {
      if (event.kind !== POLICY_DENIED_KIND) continue;
      policyDenials.push({ taskId: task.id, at: event.at, detail: event.detail });
    }
  }
  policyDenials.sort((a, b) => (a.at === b.at ? a.taskId.localeCompare(b.taskId) : a.at.localeCompare(b.at)));

  // --------------------------------------------------------- validation

  const validationByLevel: Record<string, Record<string, number>> = {};
  const validationTotals: Record<string, number> = {};
  for (const row of validationRows) {
    const bucket = (validationByLevel[row.level] ??= { passed: 0, failed: 0, skipped: 0, inconclusive: 0 });
    const seen = bucket[row.state];
    if (seen !== undefined) bucket[row.state] = seen + 1;
    validationTotals[row.state] = (validationTotals[row.state] ?? 0) + 1;
  }

  // ------------------------------------------------- blockers/uncertain

  const blockers: BlockerEntry[] = [];
  for (const record of analyses) {
    for (const blocker of record.blockers) {
      blockers.push({
        scope: "unit",
        id: record.unitId,
        text: blocker.text,
        evidence: blocker.evidence.map((entry) => `${entry.path}:${String(entry.line)}`),
      });
    }
  }
  if (plan !== null) {
    for (const blockage of plan.blockages) {
      blockers.push({
        scope: "plan",
        id: blockage.unitId,
        text: `${blockage.reason} (requires approval: ${blockage.requiredApproval})`,
        evidence: [],
      });
    }
  }
  for (const task of tasks) {
    if (task.state !== "BLOCKED" && task.state !== "FAILED") continue;
    const events = (eventsByTask.get(task.id) ?? []).filter(
      (event) => FAILURE_EVENT_KINDS.includes(event.kind) || (event.kind === INTEGRATION_EVENT_KIND && reviewDetail(event)?.state === "rejected"),
    );
    const detail = task.blockReason ?? (events.length === 0 ? `task is ${task.state}` : reasonText(events.at(-1)?.detail));
    blockers.push({ scope: "task", id: task.id, text: detail, evidence: events.map((event) => `${event.at} ${event.kind}`) });
  }
  blockers.sort((a, b) => (a.scope === b.scope ? a.id.localeCompare(b.id) : a.scope.localeCompare(b.scope)));

  const uncertainties: UncertaintyEntry[] = [];
  const unresolvedReferences: UnresolvedEntry[] = [];
  for (const record of analyses) {
    for (const uncertainty of record.uncertainties) {
      uncertainties.push({ unitId: record.unitId, text: uncertainty.text, basis: uncertainty.basis });
    }
    for (const unresolved of record.dependencies.unresolved) {
      unresolvedReferences.push({ unitId: record.unitId, symbol: unresolved.symbol, reason: unresolved.reason });
    }
  }
  uncertainties.sort((a, b) => (a.unitId === b.unitId ? a.text.localeCompare(b.text) : a.unitId.localeCompare(b.unitId)));
  unresolvedReferences.sort((a, b) => (a.unitId === b.unitId ? a.symbol.localeCompare(b.symbol) : a.unitId.localeCompare(b.unitId)));

  const skippedChecks: SkippedCheck[] = validationRows
    .filter((row) => row.state === "skipped")
    .map((row) => ({ checkId: row.checkId, level: row.level, name: row.name, reason: row.reason ?? "no reason recorded" }))
    .sort((a, b) => a.checkId.localeCompare(b.checkId));

  // -------------------------------------------------------------- usage

  const latestRun = repo.latestRun();
  const latestRunUsage = latestRun === null ? null : repo.totalsForRun(latestRun.id);
  const taskUsage = tasks
    .map((task: TaskRecord) => ({ taskId: task.id, usage: repo.totalsForTask(task.id) }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  // ------------------------------------------------------------ summary

  const accountedFiles = fileDispositions.filter((entry) => isDisposition(entry.disposition)).length;
  const totalFiles = fileDispositions.length;
  const applicableChecks = validationRows.filter((row) => row.state !== "skipped");
  const passedChecks = validationRows.filter((row) => row.state === "passed");
  const behavioralAttempted = validationRows.filter((row) => row.level === "D" && row.state !== "skipped");
  const behavioralPassed = behavioralAttempted.filter((row) => row.state === "passed");

  const summary = {
    fileCoverage: {
      label: "file coverage",
      numerator: accountedFiles,
      denominator: totalFiles,
      percent: percentOf(accountedFiles, totalFiles),
      basis: "inventory files carrying a recorded disposition (file coverage only)",
    },
    testCoverage: {
      label: "test coverage",
      numerator: passedChecks.length,
      denominator: applicableChecks.length,
      percent: percentOf(passedChecks.length, applicableChecks.length),
      basis: "checks in state passed over applicable checks (passed + failed + inconclusive; skipped checks are not applicable)",
    },
    behavioralVerification: {
      label: "behavioral verification",
      numerator: behavioralPassed.length,
      denominator: behavioralAttempted.length,
      percent: percentOf(behavioralPassed.length, behavioralAttempted.length),
      basis: "level-D checks passed over level-D checks attempted; n/a when none were attempted",
    },
  } as const;

  const json: ReportJson = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: nowIso(),
    workspaceRoot: paths.root,
    provenance: {
      sourceSnapshotId: snapshot?.snapshotId ?? inventory?.sourceSnapshotId ?? null,
      baselineId: baseline?.baselineId ?? inventory?.baselineId ?? null,
      baseline,
      snapshotEntryCount: snapshot?.entries.length ?? null,
      snapshotExcludedCount: snapshot?.excluded.length ?? null,
    },
    versions: {
      deepConvert: packageVersion(),
      node: process.version,
      gm2godotVersion: baseline?.gm2godot.version ?? inventory?.tool.gm2godot.version ?? null,
      gm2godotCommit: baseline?.gm2godot.commit ?? inventory?.tool.gm2godot.commit ?? null,
      gm2godotCheckout: baseline?.gm2godot.checkout ?? workspace.config.gm2godot.checkout,
      python: baseline?.gm2godot.python ?? workspace.config.gm2godot.python,
      pythonVersion: baseline?.gm2godot.pythonVersion ?? inventory?.tool.python ?? null,
      engineExpected: workspace.config.godot.expectedVersion,
      engineObserved,
      agentArtifacts,
    },
    adapters: {
      runtimeLines,
      sandboxConfigured: workspace.config.sandbox.backend,
      sandboxResolved,
      sandboxAvailable,
      sandboxDetail,
      checksBySandbox,
      unsafeLocalChecks,
      unsafeLocalBanner: unsafeLocal ? UNSAFE_LOCAL_BANNER : null,
    },
    dispositions: { units: unitDispositions, files: fileDispositions, counts: dispositionCounts },
    changes: { accepted, rejected, policyDenials },
    validation: { checks: validationRows, byLevel: validationByLevel, totals: validationTotals },
    blockers,
    uncertainties,
    unresolvedReferences,
    skippedChecks,
    usage: {
      artifacts: sumUsage(agentArtifacts),
      latestRunId: latestRun?.id ?? null,
      latestRun: latestRunUsage,
      tasks: taskUsage,
    },
    counts: {
      unitsByState: repo.countUnitsByState(),
      tasksByState: repo.countTasksByState(),
      portRevision: repo.currentPortRevision(),
      portRevisionCount: repo.listPortRevisions().length,
    },
    summary,
    readErrors,
  };

  return { json, markdown: renderMarkdown(json) };
}

/**
 * Write the report artifacts. The JSON is the machine-readable record; the markdown is the same
 * content rendered for a human, including the two limitations that bound what the evidence proves.
 */
export async function writeReport(
  deps: ReportDeps,
): Promise<{ jsonPath: string; markdownPath: string; json: ReportJson; markdown: string }> {
  const { json, markdown } = await buildReport(deps);
  const jsonPath = join(deps.workspace.paths.evidenceReports, REPORT_JSON_FILENAME);
  const markdownPath = join(deps.workspace.paths.evidenceReports, REPORT_MARKDOWN_FILENAME);
  writeJsonAtomic(jsonPath, json);
  writeTextAtomic(markdownPath, markdown);
  deps.logger.debug(`report: wrote ${jsonPath} and ${markdownPath}`);
  return { jsonPath, markdownPath, json, markdown };
}

// ------------------------------------------------------------------ markdown

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "_none_";
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells
      .map((value, index) => {
        const width = widths[index] ?? 0;
        return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value.padEnd(width);
      })
      .join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map((row) => line(header.map((_, index) => row[index] ?? ""))),
  ].join("\n");
}

function usageLine(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; reported: boolean }): string {
  if (!usage.reported) return "provider did not report usage";
  return `input=${String(usage.input)} output=${String(usage.output)} cacheRead=${String(usage.cacheRead)} cacheWrite=${String(usage.cacheWrite)} costUsd=${usage.costUsd.toFixed(4)}`;
}

function summaryLine(summary: SummaryNumber): string {
  const percent = summary.percent === null ? "n/a" : `${summary.percent.toFixed(2)}%`;
  return `${summary.label}: ${String(summary.numerator)}/${String(summary.denominator)} (${percent}) — basis: ${summary.basis}`;
}

function renderMarkdown(report: ReportJson): string {
  const lines: string[] = [];
  const { provenance, versions, adapters, dispositions, changes, validation } = report;

  lines.push("# gm2godot-deep evidence report", "");
  lines.push(`Generated: ${report.generatedAt}`, `Workspace: ${report.workspaceRoot}`, "");

  if (adapters.unsafeLocalBanner !== null) {
    lines.push(`> ## ⚠ ${UNSAFE_LOCAL_BANNER}`, ">", "> One or more checks ran with no isolation at all.", ">");
  }

  lines.push("## 1. Source and baseline provenance", "");
  lines.push(
    table(
      ["field", "value"],
      [
        ["sourceSnapshotId", provenance.sourceSnapshotId ?? "not recorded"],
        ["snapshot entries", provenance.snapshotEntryCount === null ? "not recorded" : String(provenance.snapshotEntryCount)],
        ["snapshot excluded", provenance.snapshotExcludedCount === null ? "not recorded" : String(provenance.snapshotExcludedCount)],
        ["baselineId", provenance.baselineId ?? "not recorded"],
        ["GM2Godot version", versions.gm2godotVersion ?? "not recorded"],
        ["GM2Godot commit", versions.gm2godotCommit ?? "not recorded"],
        ["GM2Godot checkout", versions.gm2godotCheckout ?? "not recorded"],
        ["python", versions.python ?? "not recorded"],
        ["python version", versions.pythonVersion ?? "not recorded"],
        ["converter exit code", provenance.baseline === null ? "no baseline evidence" : String(provenance.baseline.exitCode)],
        ["converter state", provenance.baseline?.state ?? "not recorded"],
        ["converter outcome", provenance.baseline?.outcome ?? "not recorded"],
        ["converter summary", provenance.baseline?.summaryLine ?? "not recorded"],
        ["manifest sha256", provenance.baseline?.manifestSha256 ?? "not recorded"],
        ["attempt sha256", provenance.baseline?.attemptSha256 ?? "not recorded"],
        [
          "preserved generation",
          provenance.baseline?.preservedGeneration == null
            ? "absent"
            : `present status=${provenance.baseline.preservedGeneration.status ?? "null"} currentOutput=${provenance.baseline.preservedGeneration.currentOutput ?? "null"} sha256=${provenance.baseline.preservedGeneration.sha256 ?? "null"}`,
        ],
        ["baseline reasons", provenance.baseline === null || provenance.baseline.reasons.length === 0 ? "none" : provenance.baseline.reasons.join("; ")],
      ],
    ),
    "",
  );

  lines.push("## 2. Converter, engine and model versions", "");
  lines.push(
    table(
      ["component", "version"],
      [
        ["gm2godot-deep", versions.deepConvert],
        ["node", versions.node],
        ["GM2Godot", versions.gm2godotVersion ?? "not recorded"],
        ["GM2Godot commit", versions.gm2godotCommit ?? "not recorded"],
        ["python", versions.pythonVersion ?? versions.python ?? "not recorded"],
        ["Godot expected", versions.engineExpected],
        ["Godot observed", versions.engineObserved.length === 0 ? "no engine version recorded by a check" : versions.engineObserved.join(", ")],
      ],
    ),
    "",
  );
  lines.push(
    table(
      ["artifact", "unit", "runtime", "provider", "model", "prompt", "usage"],
      report.versions.agentArtifacts.map((artifact) => [
        `${artifact.kind} ${artifact.path}`,
        artifact.unitId ?? "—",
        artifact.runtime,
        artifact.provider ?? "—",
        artifact.model ?? "—",
        artifact.promptVersion,
        usageLine(artifact.usage),
      ]),
    ),
    "",
  );

  lines.push("## 3. Adapters: real or mock", "");
  lines.push(
    adapters.runtimeLines.length === 0
      ? "_no agent artifacts recorded: no model was exercised_"
      : adapters.runtimeLines.map((line) => `- runtime: ${line}`).join("\n"),
    "",
  );
  lines.push(
    `- sandbox configured: ${adapters.sandboxConfigured}`,
    adapters.sandboxAvailable
      ? `- sandbox resolved: ${adapters.sandboxResolved} (available)`
      : `- sandbox resolved: ${adapters.sandboxResolved} (unavailable) — ${adapters.sandboxDetail}`,
    adapters.unsafeLocalChecks.length === 0
      ? `- ${UNSAFE_LOCAL_BANNER}: not used by any check`
      : `- ${UNSAFE_LOCAL_BANNER}: ${adapters.unsafeLocalChecks.join(", ")}`,
    "",
  );
  lines.push(
    table(
      ["check", "sandbox backend (as recorded by the check)"],
      adapters.checksBySandbox.map((entry) => [entry.checkId, entry.backend ?? "not recorded by the check"]),
    ),
    "",
  );

  lines.push("## 4. Resource dispositions", "");
  lines.push(`Files by disposition: ${Object.entries(dispositions.counts).sort().map(([key, value]) => `${key}=${String(value)}`).join(" ") || "—"}`, "");
  lines.push(
    table(
      ["unit", "kind", "name", "disposition", "basis"],
      dispositions.units.map((entry) => [entry.unitId, entry.kind, entry.name, entry.disposition, entry.basis]),
    ),
    "",
  );
  lines.push(
    table(
      ["file", "classification", "disposition", "basis"],
      dispositions.files.map((entry) => [entry.path, entry.classification, entry.disposition, entry.basis]),
    ),
    "",
  );

  lines.push("## 5. Accepted and rejected changes", "");
  lines.push(
    table(
      ["patch", "task", "sha256", "published revision", "review verdict", "files"],
      changes.accepted.map((change) => [
        change.patchId ?? "—",
        change.taskId,
        change.patchSha256,
        String(change.publishedRevision),
        change.reviewVerdict ?? "no review recorded",
        change.files.join(", "),
      ]),
    ),
    "",
  );
  lines.push(
    table(
      ["patch", "task", "sha256", "state", "review verdict", "reasons"],
      changes.rejected.map((change) => [
        change.patchId,
        change.taskId,
        change.patchSha256,
        change.state,
        change.reviewVerdict ?? "no review recorded",
        change.reasons.length === 0 ? "no rejection event recorded" : change.reasons.join(" | "),
      ]),
    ),
    "",
  );
  lines.push(
    table(
      ["task", "at", "policy denial"],
      changes.policyDenials.map((denial) => [denial.taskId, denial.at, JSON.stringify(denial.detail)]),
    ),
    "",
  );

  lines.push("## 6. Validation results by level", "");
  lines.push(
    table(
      ["level", "passed", "failed", "skipped", "inconclusive"],
      ["A", "B", "C", "D", "E"].map((level) => [
        level,
        String(validation.byLevel[level]?.["passed"] ?? 0),
        String(validation.byLevel[level]?.["failed"] ?? 0),
        String(validation.byLevel[level]?.["skipped"] ?? 0),
        String(validation.byLevel[level]?.["inconclusive"] ?? 0),
      ]),
    ),
    "",
  );
  lines.push(
    table(
      ["check", "level", "name", "state", "command", "exit", "engine", "reason"],
      validation.checks.map((row) => [
        row.checkId,
        row.level,
        row.name,
        row.state,
        row.command ?? "—",
        row.exitStatus === null ? "—" : String(row.exitStatus),
        row.engineVersion ?? "—",
        row.reason ?? "—",
      ]),
    ),
    "",
  );

  lines.push("## 7. Remaining blockers and uncertainties", "");
  lines.push(
    "Blockers:",
    "",
    table(
      ["scope", "id", "blocker", "evidence"],
      report.blockers.map((blocker) => [blocker.scope, blocker.id, blocker.text, blocker.evidence.join(", ")]),
    ),
    "",
    "Uncertainties:",
    "",
    table(
      ["unit", "uncertainty", "basis"],
      report.uncertainties.map((entry) => [entry.unitId, entry.text, entry.basis]),
    ),
    "",
    "Unresolved dynamic references:",
    "",
    table(
      ["unit", "symbol", "reason"],
      report.unresolvedReferences.map((entry) => [entry.unitId, entry.symbol, entry.reason]),
    ),
    "",
  );

  lines.push("## 8. Skipped checks", "");
  lines.push(
    table(
      ["check", "level", "name", "reason"],
      report.skippedChecks.map((check) => [check.checkId, check.level, check.name, check.reason]),
    ),
    "",
  );

  lines.push("## 9. Model usage", "");
  lines.push(`- artifacts: ${usageLine(report.usage.artifacts)}`);
  lines.push(`- latest run ${report.usage.latestRunId ?? "(none)"}: ${report.usage.latestRun === null ? "no ledger rows" : usageLine(report.usage.latestRun)}`);
  lines.push(
    table(
      ["task", "usage"],
      report.usage.tasks.map((entry) => [entry.taskId, usageLine(entry.usage)]),
    ),
    "",
  );

  lines.push("## 10. Summary numbers (never combined)", "");
  lines.push(
    `- ${summaryLine(report.summary.fileCoverage)}`,
    `- ${summaryLine(report.summary.testCoverage)}`,
    `- ${summaryLine(report.summary.behavioralVerification)}`,
    "",
    "These three numbers measure different things and are never combined into a compatibility percentage.",
    "",
  );

  lines.push("## Counts", "");
  lines.push(
    `- units by state: ${Object.entries(report.counts.unitsByState).sort().map(([key, value]) => `${key}=${String(value)}`).join(" ") || "—"}`,
    `- tasks by state: ${Object.entries(report.counts.tasksByState).sort().map(([key, value]) => `${key}=${String(value)}`).join(" ") || "—"}`,
    `- port revision: ${String(report.counts.portRevision)} (${String(report.counts.portRevisionCount)} revision record(s))`,
    "",
  );

  if (report.readErrors.length > 0) {
    lines.push("## Unreadable artifacts", "");
    lines.push(
      table(
        ["artifact", "error"],
        report.readErrors.map((entry) => [entry.path, entry.error]),
      ),
      "",
    );
  }

  lines.push("## Limitations", "");
  lines.push(
    `- ${EVIDENCE_LIMITATION}.`,
    `- ${SYNTHETIC_LIMITATION}.`,
    "- This report states only what was recorded; a skipped check is never evidence of success.",
    "",
  );

  return `${lines.join("\n").trimEnd()}\n`;
}
