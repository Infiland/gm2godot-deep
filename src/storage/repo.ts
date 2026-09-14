import type { SQLOutputValue } from "node:sqlite";
import { nowIso } from "../util/ids.ts";
import { transact, type Database } from "./db.ts";
import type {
  AgentRoleName,
  Allowlist,
  IntegrationRecord,
  LeaseRecord,
  PatchRecord,
  RiskAssessment,
  RunRecord,
  TaskBudgets,
  TaskRecord,
  TaskState,
  UnitRecord,
  UnitStrategy,
  UsageTotals,
  ValidationRow,
} from "./types.ts";

type Row = Record<string, SQLOutputValue>;

function str(value: SQLOutputValue | undefined, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`column ${field} is not text`);
}

function optStr(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return String(value);
}

function num(value: SQLOutputValue | undefined, field: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`column ${field} is not numeric`);
}

function optNum(value: SQLOutputValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function flag(value: SQLOutputValue | undefined): boolean {
  return num(value, "flag") !== 0;
}

function parseJson(value: SQLOutputValue | undefined): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  return JSON.parse(value);
}

function rowOf(value: Row | undefined, what: string): Row {
  if (value === undefined) throw new Error(`row not found: ${what}`);
  return value;
}

/**
 * The only place raw SQL lives. Everything above this file uses typed accessors so a schema change
 * cannot silently drift from the code that reads it.
 */
export class Repo {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ---------------------------------------------------------------- runs

  createRun(
    id: string,
    throughPhase: string,
    execute: boolean,
    detail: unknown = {},
  ): RunRecord {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, started_at, updated_at, finished_at, through_phase, phase, status, execute, detail_json)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        at,
        at,
        throughPhase,
        "init",
        "running",
        execute ? 1 : 0,
        JSON.stringify(detail),
      );
    return this.getRun(id);
  }

  getRun(id: string): RunRecord {
    const row = rowOf(
      this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
        | Row
        | undefined,
      `run ${id}`,
    );
    return {
      id: str(row["id"], "id"),
      startedAt: str(row["started_at"], "started_at"),
      updatedAt: str(row["updated_at"], "updated_at"),
      finishedAt: optStr(row["finished_at"]),
      throughPhase: str(row["through_phase"], "through_phase"),
      phase: str(row["phase"], "phase"),
      status: str(row["status"], "status"),
      execute: flag(row["execute"]),
      detail: parseJson(row["detail_json"]),
    };
  }

  latestRun(): RunRecord | null {
    const row = this.db
      .prepare("SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT 1")
      .get() as Row | undefined;
    return row === undefined ? null : this.getRun(str(row["id"], "id"));
  }

  updateRunPhase(id: string, phase: string, detail?: unknown): void {
    if (detail === undefined) {
      this.db
        .prepare("UPDATE runs SET phase = ?, updated_at = ? WHERE id = ?")
        .run(phase, nowIso(), id);
      return;
    }
    this.db
      .prepare(
        "UPDATE runs SET phase = ?, updated_at = ?, detail_json = ? WHERE id = ?",
      )
      .run(phase, nowIso(), JSON.stringify(detail), id);
  }

  finishRun(id: string, status: string, detail?: unknown): void {
    const at = nowIso();
    this.db
      .prepare(
        "UPDATE runs SET status = ?, finished_at = ?, updated_at = ?, detail_json = COALESCE(?, detail_json) WHERE id = ?",
      )
      .run(
        status,
        at,
        at,
        detail === undefined ? null : JSON.stringify(detail),
        id,
      );
  }

  // --------------------------------------------------------------- units

  upsertUnit(unit: {
    id: string;
    kind: string;
    name: string;
    analysisRequired: boolean;
    deterministic: boolean;
    state: TaskState;
    sourceHashes: Record<string, string>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO units (id, kind, name, analysis_required, deterministic, state, strategy, risk_level, risk_json,
                            group_id, source_hashes_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           analysis_required = excluded.analysis_required,
           deterministic = excluded.deterministic,
           source_hashes_json = excluded.source_hashes_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        unit.id,
        unit.kind,
        unit.name,
        unit.analysisRequired ? 1 : 0,
        unit.deterministic ? 1 : 0,
        unit.state,
        JSON.stringify(unit.sourceHashes),
        nowIso(),
      );
  }

  getUnit(id: string): UnitRecord | null {
    const row = this.db.prepare("SELECT * FROM units WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row === undefined ? null : mapUnit(row);
  }

  listUnits(): UnitRecord[] {
    return (
      this.db.prepare("SELECT * FROM units ORDER BY id").all() as Row[]
    ).map(mapUnit);
  }

  setUnitState(id: string, state: TaskState): void {
    this.db
      .prepare("UPDATE units SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, nowIso(), id);
  }

  setUnitStrategy(id: string, strategy: UnitStrategy): void {
    this.db
      .prepare("UPDATE units SET strategy = ?, updated_at = ? WHERE id = ?")
      .run(strategy, nowIso(), id);
  }

  setUnitRisk(id: string, risk: RiskAssessment): void {
    this.db
      .prepare(
        "UPDATE units SET risk_level = ?, risk_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(risk.level, JSON.stringify(risk), nowIso(), id);
  }

  setUnitGroup(id: string, groupId: string | null): void {
    this.db
      .prepare("UPDATE units SET group_id = ?, updated_at = ? WHERE id = ?")
      .run(groupId, nowIso(), id);
  }

  countUnitsByState(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM units GROUP BY state")
      .all() as Row[];
    const counts: Record<string, number> = {};
    for (const row of rows)
      counts[str(row["state"], "state")] = num(row["n"], "n");
    return counts;
  }

  // --------------------------------------------------------------- tasks

  insertTask(task: {
    id: string;
    unitIds: readonly string[];
    role: AgentRoleName;
    state: TaskState;
    strategy: UnitStrategy;
    maxAttempts: number;
    allowlist: Allowlist;
    dependsOn: readonly string[];
    contractVersions: Record<string, number>;
    inputHash: string;
    acceptanceCheckIds: readonly string[];
    reviewRequired: boolean;
    budgets: TaskBudgets;
    blockReason?: string | null;
  }): void {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (id, unit_ids_json, role, state, strategy, attempt, max_attempts, allowlist_json,
                            depends_on_json, contract_versions_json, input_hash, acceptance_check_ids_json,
                            review_required, budgets_json, block_reason, published_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        task.id,
        JSON.stringify(task.unitIds),
        task.role,
        task.state,
        task.strategy,
        task.maxAttempts,
        JSON.stringify(task.allowlist),
        JSON.stringify(task.dependsOn),
        JSON.stringify(task.contractVersions),
        task.inputHash,
        JSON.stringify(task.acceptanceCheckIds),
        task.reviewRequired ? 1 : 0,
        JSON.stringify(task.budgets),
        task.blockReason ?? null,
        at,
        at,
      );
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row === undefined ? null : mapTask(row);
  }

  listTasks(): TaskRecord[] {
    return (
      this.db.prepare("SELECT * FROM tasks ORDER BY id").all() as Row[]
    ).map(mapTask);
  }

  listTasksInState(state: TaskState): TaskRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE state = ? ORDER BY id")
        .all(state) as Row[]
    ).map(mapTask);
  }

  countTasksByState(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state")
      .all() as Row[];
    const counts: Record<string, number> = {};
    for (const row of rows)
      counts[str(row["state"], "state")] = num(row["n"], "n");
    return counts;
  }

  setTaskBlockReason(id: string, reason: string | null): void {
    this.db
      .prepare("UPDATE tasks SET block_reason = ?, updated_at = ? WHERE id = ?")
      .run(reason, nowIso(), id);
  }

  setTaskPublishedRevision(id: string, revision: number): void {
    this.db
      .prepare(
        "UPDATE tasks SET published_revision = ?, updated_at = ? WHERE id = ?",
      )
      .run(revision, nowIso(), id);
  }

  setTaskContractVersions(id: string, versions: Record<string, number>): void {
    this.db
      .prepare(
        "UPDATE tasks SET contract_versions_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(versions), nowIso(), id);
  }

  // ---------------------------------------------------------- task events

  appendEvent(event: {
    taskId: string;
    kind: string;
    fromState?: TaskState | null;
    toState?: TaskState | null;
    attempt?: number | null;
    detail?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_events (task_id, at, kind, from_state, to_state, attempt, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.taskId,
        nowIso(),
        event.kind,
        event.fromState ?? null,
        event.toState ?? null,
        event.attempt ?? null,
        JSON.stringify(event.detail ?? {}),
      );
  }

  listEvents(
    taskId: string,
  ): {
    at: string;
    kind: string;
    fromState: string | null;
    toState: string | null;
    attempt: number | null;
    detail: unknown;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id")
      .all(taskId) as Row[];
    return rows.map((row) => ({
      at: str(row["at"], "at"),
      kind: str(row["kind"], "kind"),
      fromState: optStr(row["from_state"]),
      toState: optStr(row["to_state"]),
      attempt: optNum(row["attempt"]),
      detail: parseJson(row["detail_json"]),
    }));
  }

  listRecentEvents(
    limit: number,
  ): {
    taskId: string;
    at: string;
    kind: string;
    fromState: string | null;
    toState: string | null;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM task_events ORDER BY id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((row) => ({
      taskId: str(row["task_id"], "task_id"),
      at: str(row["at"], "at"),
      kind: str(row["kind"], "kind"),
      fromState: optStr(row["from_state"]),
      toState: optStr(row["to_state"]),
    }));
  }

  // -------------------------------------------------------------- leases

  ensureLeaseRow(taskId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO leases (task_id, owner, acquired_at, expires_at) VALUES (?, NULL, NULL, NULL)",
      )
      .run(taskId);
  }

  /**
   * Claim a task lease. A 0-row result means somebody else holds it; the caller must not assume the
   * lease. Expired leases are stealable, which is the crash-recovery path.
   */
  acquireLease(taskId: string, owner: string, ttlSeconds: number): boolean {
    const now = nowIso();
    const expires = new Date(Date.now() + ttlSeconds * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const result = this.db
      .prepare(
        `UPDATE leases SET owner = ?, acquired_at = ?, expires_at = ?
         WHERE task_id = ? AND (owner IS NULL OR expires_at IS NULL OR expires_at < ?)`,
      )
      .run(owner, now, expires, taskId, now);
    return Number(result.changes) > 0;
  }

  heartbeatLease(taskId: string, owner: string, ttlSeconds: number): boolean {
    const expires = new Date(Date.now() + ttlSeconds * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const result = this.db
      .prepare(
        "UPDATE leases SET expires_at = ? WHERE task_id = ? AND owner = ?",
      )
      .run(expires, taskId, owner);
    return Number(result.changes) > 0;
  }

  releaseLease(taskId: string, owner: string): void {
    this.db
      .prepare(
        "UPDATE leases SET owner = NULL, acquired_at = NULL, expires_at = NULL WHERE task_id = ? AND owner = ?",
      )
      .run(taskId, owner);
  }

  listLeases(): LeaseRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM leases ORDER BY task_id")
      .all() as Row[];
    return rows.map((row) => ({
      taskId: str(row["task_id"], "task_id"),
      owner: optStr(row["owner"]),
      acquiredAt: optStr(row["acquired_at"]),
      expiresAt: optStr(row["expires_at"]),
    }));
  }

  /** Tasks whose lease expired before `at`; the scheduler returns them to READY. */
  expiredLeases(at: string): LeaseRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM leases WHERE owner IS NOT NULL AND expires_at IS NOT NULL AND expires_at < ? ORDER BY task_id",
      )
      .all(at) as Row[];
    return rows.map((row) => ({
      taskId: str(row["task_id"], "task_id"),
      owner: optStr(row["owner"]),
      acquiredAt: optStr(row["acquired_at"]),
      expiresAt: optStr(row["expires_at"]),
    }));
  }

  // ------------------------------------------------------------- patches

  insertPatch(patch: {
    id: string;
    taskId: string;
    attempt: number;
    sha256: string;
    path: string;
    diffPath: string;
    basePortRevision: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO patches (id, task_id, attempt, sha256, path, diff_path, base_port_revision, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      )
      .run(
        patch.id,
        patch.taskId,
        patch.attempt,
        patch.sha256,
        patch.path,
        patch.diffPath,
        patch.basePortRevision,
        nowIso(),
      );
  }

  getPatch(id: string): PatchRecord | null {
    const row = this.db
      .prepare("SELECT * FROM patches WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? null : mapPatch(row);
  }

  findPatch(taskId: string, sha256: string): PatchRecord | null {
    const row = this.db
      .prepare("SELECT * FROM patches WHERE task_id = ? AND sha256 = ?")
      .get(taskId, sha256) as Row | undefined;
    return row === undefined ? null : mapPatch(row);
  }

  setPatchState(id: string, state: string): void {
    this.db.prepare("UPDATE patches SET state = ? WHERE id = ?").run(state, id);
  }

  listPatches(taskId?: string): PatchRecord[] {
    const rows = (
      taskId === undefined
        ? this.db.prepare("SELECT * FROM patches ORDER BY created_at, id").all()
        : this.db
            .prepare(
              "SELECT * FROM patches WHERE task_id = ? ORDER BY created_at, id",
            )
            .all(taskId)
    ) as Row[];
    return rows.map(mapPatch);
  }

  // -------------------------------------------------------- integrations

  /** Idempotent publish: the second identical call returns the original row and changes nothing. */
  insertIntegration(record: {
    id: string;
    taskId: string;
    patchSha256: string;
    basePortRevision: number;
    publishedRevision: number;
    idempotencyKey: string;
    files: readonly string[];
  }): IntegrationRecord {
    return transact(this.db, () => {
      const existing = this.db
        .prepare("SELECT * FROM integrations WHERE idempotency_key = ?")
        .get(record.idempotencyKey) as Row | undefined;
      if (existing !== undefined) return mapIntegration(existing);
      this.db
        .prepare(
          `INSERT INTO integrations (id, task_id, patch_sha256, base_port_revision, published_revision,
                                     idempotency_key, files_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.taskId,
          record.patchSha256,
          record.basePortRevision,
          record.publishedRevision,
          record.idempotencyKey,
          JSON.stringify(record.files),
          nowIso(),
        );
      return this.getIntegrationByKey(
        record.idempotencyKey,
      ) as IntegrationRecord;
    });
  }

  getIntegrationByKey(key: string): IntegrationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM integrations WHERE idempotency_key = ?")
      .get(key) as Row | undefined;
    return row === undefined ? null : mapIntegration(row);
  }

  listIntegrations(): IntegrationRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM integrations ORDER BY created_at, id")
        .all() as Row[]
    ).map(mapIntegration);
  }

  // ------------------------------------------------------- port revisions

  currentPortRevision(): number {
    const row = this.db
      .prepare("SELECT MAX(revision) AS r FROM port_revisions")
      .get() as Row | undefined;
    return row === undefined ? 0 : (optNum(row["r"]) ?? 0);
  }

  bumpPortRevision(record: {
    taskId: string | null;
    integrationId: string | null;
    files: readonly string[];
  }): number {
    return transact(this.db, () => {
      const next = this.currentPortRevision() + 1;
      this.db
        .prepare(
          "INSERT INTO port_revisions (revision, created_at, task_id, integration_id, files_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          next,
          nowIso(),
          record.taskId,
          record.integrationId,
          JSON.stringify(record.files),
        );
      return next;
    });
  }

  listPortRevisions(): {
    revision: number;
    createdAt: string;
    taskId: string | null;
    files: readonly string[];
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM port_revisions ORDER BY revision")
      .all() as Row[];
    return rows.map((row) => ({
      revision: num(row["revision"], "revision"),
      createdAt: str(row["created_at"], "created_at"),
      taskId: optStr(row["task_id"]),
      files: (parseJson(row["files_json"]) as string[] | null) ?? [],
    }));
  }

  // ------------------------------------------------------------ analyses

  upsertAnalysis(record: {
    unitId: string;
    path: string;
    sha256: string;
    schemaVersion: number;
    riskLevel: string | null;
    strategy: string | null;
    producedBy: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO analyses (unit_id, path, sha256, schema_version, risk_level, strategy, produced_by_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(unit_id) DO UPDATE SET
           path = excluded.path, sha256 = excluded.sha256, schema_version = excluded.schema_version,
           risk_level = excluded.risk_level, strategy = excluded.strategy,
           produced_by_json = excluded.produced_by_json, created_at = excluded.created_at`,
      )
      .run(
        record.unitId,
        record.path,
        record.sha256,
        record.schemaVersion,
        record.riskLevel,
        record.strategy,
        JSON.stringify(record.producedBy),
        nowIso(),
      );
  }

  listAnalyses(): {
    unitId: string;
    path: string;
    sha256: string;
    riskLevel: string | null;
    strategy: string | null;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM analyses ORDER BY unit_id")
      .all() as Row[];
    return rows.map((row) => ({
      unitId: str(row["unit_id"], "unit_id"),
      path: str(row["path"], "path"),
      sha256: str(row["sha256"], "sha256"),
      riskLevel: optStr(row["risk_level"]),
      strategy: optStr(row["strategy"]),
    }));
  }

  getAnalysis(
    unitId: string,
  ): {
    unitId: string;
    path: string;
    sha256: string;
    riskLevel: string | null;
    strategy: string | null;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM analyses WHERE unit_id = ?")
      .get(unitId) as Row | undefined;
    if (row === undefined) return null;
    return {
      unitId: str(row["unit_id"], "unit_id"),
      path: str(row["path"], "path"),
      sha256: str(row["sha256"], "sha256"),
      riskLevel: optStr(row["risk_level"]),
      strategy: optStr(row["strategy"]),
    };
  }

  // ----------------------------------------------------------- contracts

  upsertContract(record: {
    concern: string;
    version: number;
    path: string;
    sha256: string;
    policy: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO contracts (concern, version, path, sha256, policy_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(concern, version) DO UPDATE SET
           path = excluded.path, sha256 = excluded.sha256, policy_json = excluded.policy_json`,
      )
      .run(
        record.concern,
        record.version,
        record.path,
        record.sha256,
        JSON.stringify(record.policy),
        nowIso(),
      );
  }

  listContracts(): {
    concern: string;
    version: number;
    path: string;
    sha256: string;
    policy: unknown;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM contracts ORDER BY concern, version")
      .all() as Row[];
    return rows.map((row) => ({
      concern: str(row["concern"], "concern"),
      version: num(row["version"], "version"),
      path: str(row["path"], "path"),
      sha256: str(row["sha256"], "sha256"),
      policy: parseJson(row["policy_json"]),
    }));
  }

  latestContractVersions(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT concern, MAX(version) AS v FROM contracts GROUP BY concern",
      )
      .all() as Row[];
    const versions: Record<string, number> = {};
    for (const row of rows)
      versions[str(row["concern"], "concern")] = num(row["v"], "v");
    return versions;
  }

  bindContractRule(
    concern: string,
    version: number,
    unitId: string,
    ruleId: string,
  ): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO contract_bindings (concern, version, unit_id, rule_id) VALUES (?, ?, ?, ?)",
      )
      .run(concern, version, unitId, ruleId);
  }

  listBindingsForUnit(
    unitId: string,
  ): { concern: string; version: number; ruleId: string }[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM contract_bindings WHERE unit_id = ? ORDER BY concern, rule_id",
      )
      .all(unitId) as Row[];
    return rows.map((row) => ({
      concern: str(row["concern"], "concern"),
      version: num(row["version"], "version"),
      ruleId: str(row["rule_id"], "rule_id"),
    }));
  }

  listBindingsForConcern(
    concern: string,
  ): { version: number; unitId: string; ruleId: string }[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM contract_bindings WHERE concern = ? ORDER BY version, unit_id, rule_id",
      )
      .all(concern) as Row[];
    return rows.map((row) => ({
      version: num(row["version"], "version"),
      unitId: str(row["unit_id"], "unit_id"),
      ruleId: str(row["rule_id"], "rule_id"),
    }));
  }

  // ------------------------------------------------------------- budgets

  charge(entry: {
    runId: string;
    taskId: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    reported: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO budget_ledger (run_id, task_id, at, input_tokens, output_tokens, cache_read_tokens,
                                    cache_write_tokens, cost_usd, reported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.runId,
        entry.taskId,
        nowIso(),
        entry.input,
        entry.output,
        entry.cacheRead,
        entry.cacheWrite,
        entry.costUsd,
        entry.reported ? 1 : 0,
      );
  }

  totalsForRun(runId: string): UsageTotals {
    const row = rowOf(
      this.db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
                  COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw,
                  COALESCE(SUM(cost_usd),0) AS cost, COALESCE(MIN(reported),0) AS rep
           FROM budget_ledger WHERE run_id = ?`,
        )
        .get(runId) as Row | undefined,
      `budget totals for run ${runId}`,
    );
    return {
      input: num(row["i"], "i"),
      output: num(row["o"], "o"),
      cacheRead: num(row["cr"], "cr"),
      cacheWrite: num(row["cw"], "cw"),
      costUsd: num(row["cost"], "cost"),
      reported: flag(row["rep"]),
    };
  }

  totalsForWorkspace(): UsageTotals {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
      COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw,
      COALESCE(SUM(cost_usd),0) AS cost, COALESCE(MIN(reported),0) AS rep FROM budget_ledger`,
      )
      .get();
    return {
      input: Number(row?.["i"] ?? 0),
      output: Number(row?.["o"] ?? 0),
      cacheRead: Number(row?.["cr"] ?? 0),
      cacheWrite: Number(row?.["cw"] ?? 0),
      costUsd: Number(row?.["cost"] ?? 0),
      reported: Boolean(row?.["rep"]),
    };
  }

  totalsForTask(taskId: string): UsageTotals {
    const row = rowOf(
      this.db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
                  COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw,
                  COALESCE(SUM(cost_usd),0) AS cost, COALESCE(MIN(reported),0) AS rep
           FROM budget_ledger WHERE task_id = ?`,
        )
        .get(taskId) as Row | undefined,
      `budget totals for task ${taskId}`,
    );
    return {
      input: num(row["i"], "i"),
      output: num(row["o"], "o"),
      cacheRead: num(row["cr"], "cr"),
      cacheWrite: num(row["cw"], "cw"),
      costUsd: num(row["cost"], "cost"),
      reported: flag(row["rep"]),
    };
  }

  // --------------------------------------------------------- cache table

  putCacheEntry(
    key: string,
    unitId: string,
    kind: string,
    value: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO cache_entries (key, unit_id, kind, value_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at`,
      )
      .run(key, unitId, kind, JSON.stringify(value), nowIso());
  }

  getCacheEntry(
    key: string,
  ): { key: string; unitId: string; kind: string; value: unknown } | null {
    const row = this.db
      .prepare("SELECT * FROM cache_entries WHERE key = ?")
      .get(key) as Row | undefined;
    if (row === undefined) return null;
    return {
      key: str(row["key"], "key"),
      unitId: str(row["unit_id"], "unit_id"),
      kind: str(row["kind"], "kind"),
      value: parseJson(row["value_json"]),
    };
  }

  listCacheEntries(): { key: string; unitId: string; kind: string }[] {
    const rows = this.db
      .prepare(
        "SELECT key, unit_id, kind FROM cache_entries ORDER BY unit_id, kind",
      )
      .all() as Row[];
    return rows.map((row) => ({
      key: str(row["key"], "key"),
      unitId: str(row["unit_id"], "unit_id"),
      kind: str(row["kind"], "kind"),
    }));
  }

  clearCache(): number {
    const result = this.db.prepare("DELETE FROM cache_entries").run();
    return Number(result.changes);
  }

  deleteCacheEntriesForUnit(unitId: string): number {
    const result = this.db
      .prepare("DELETE FROM cache_entries WHERE unit_id = ?")
      .run(unitId);
    return Number(result.changes);
  }

  // --------------------------------------------------- validation results

  upsertValidation(row: ValidationRow): void {
    this.db
      .prepare(
        `INSERT INTO validation_results (check_id, task_id, level, name, state, command, engine_version,
                                         input_revision, exit_status, duration_ms, logs_path, artifacts_json,
                                         reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(check_id) DO UPDATE SET
           task_id = excluded.task_id, level = excluded.level, name = excluded.name, state = excluded.state,
           command = excluded.command, engine_version = excluded.engine_version,
           input_revision = excluded.input_revision, exit_status = excluded.exit_status,
           duration_ms = excluded.duration_ms, logs_path = excluded.logs_path,
           artifacts_json = excluded.artifacts_json, reason = excluded.reason, created_at = excluded.created_at`,
      )
      .run(
        row.checkId,
        row.taskId,
        row.level,
        row.name,
        row.state,
        row.command,
        row.engineVersion,
        row.inputRevision,
        row.exitStatus,
        row.durationMs,
        row.logsPath,
        JSON.stringify(row.artifacts),
        row.reason,
        row.createdAt,
      );
  }

  listValidation(taskId?: string): ValidationRow[] {
    const rows = (
      taskId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM validation_results ORDER BY level, check_id",
            )
            .all()
        : this.db
            .prepare(
              "SELECT * FROM validation_results WHERE task_id = ? ORDER BY level, check_id",
            )
            .all(taskId)
    ) as Row[];
    return rows.map(mapValidation);
  }

  // -------------------------------------------------------- invalidations

  recordInvalidation(row: {
    kind: string;
    concern?: string | null;
    fromVersion?: number | null;
    toVersion?: number | null;
    unitId?: string | null;
    detail?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO invalidations (at, kind, concern, from_version, to_version, unit_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nowIso(),
        row.kind,
        row.concern ?? null,
        row.fromVersion ?? null,
        row.toVersion ?? null,
        row.unitId ?? null,
        JSON.stringify(row.detail ?? {}),
      );
  }

  listInvalidations(): {
    kind: string;
    concern: string | null;
    fromVersion: number | null;
    toVersion: number | null;
    unitId: string | null;
    detail: unknown;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM invalidations ORDER BY id")
      .all() as Row[];
    return rows.map((row) => ({
      kind: str(row["kind"], "kind"),
      concern: optStr(row["concern"]),
      fromVersion: optNum(row["from_version"]),
      toVersion: optNum(row["to_version"]),
      unitId: optStr(row["unit_id"]),
      detail: parseJson(row["detail_json"]),
    }));
  }

  // ---------------------------------------------------- baseline attempts

  recordBaselineAttempt(row: {
    id: string;
    exitCode: number;
    state: string;
    fresh: boolean;
    detail: unknown;
  }): void {
    this.db
      .prepare(
        "INSERT INTO baseline_attempts (id, at, exit_code, state, fresh, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        nowIso(),
        row.exitCode,
        row.state,
        row.fresh ? 1 : 0,
        JSON.stringify(row.detail),
      );
  }

  listBaselineAttempts(): {
    id: string;
    at: string;
    exitCode: number;
    state: string;
    fresh: boolean;
    detail: unknown;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM baseline_attempts ORDER BY at, id")
      .all() as Row[];
    return rows.map((row) => ({
      id: str(row["id"], "id"),
      at: str(row["at"], "at"),
      exitCode: num(row["exit_code"], "exit_code"),
      state: str(row["state"], "state"),
      fresh: flag(row["fresh"]),
      detail: parseJson(row["detail_json"]),
    }));
  }
}

// -------------------------------------------------------------- row mappers

function mapUnit(row: Row): UnitRecord {
  return {
    id: str(row["id"], "id"),
    kind: str(row["kind"], "kind"),
    name: str(row["name"], "name"),
    analysisRequired: flag(row["analysis_required"]),
    deterministic: flag(row["deterministic"]),
    state: str(row["state"], "state") as TaskState,
    strategy: optStr(row["strategy"]) as UnitStrategy | null,
    riskLevel: optStr(row["risk_level"]) as UnitRecord["riskLevel"],
    risk: parseJson(row["risk_json"]),
    groupId: optStr(row["group_id"]),
    sourceHashes:
      (parseJson(row["source_hashes_json"]) as Record<string, string> | null) ??
      {},
    updatedAt: str(row["updated_at"], "updated_at"),
  };
}

function mapTask(row: Row): TaskRecord {
  return {
    id: str(row["id"], "id"),
    unitIds: (parseJson(row["unit_ids_json"]) as string[] | null) ?? [],
    role: str(row["role"], "role") as AgentRoleName,
    state: str(row["state"], "state") as TaskState,
    strategy: str(row["strategy"], "strategy") as UnitStrategy,
    attempt: num(row["attempt"], "attempt"),
    maxAttempts: num(row["max_attempts"], "max_attempts"),
    allowlist: (parseJson(row["allowlist_json"]) as Allowlist | null) ?? {
      read: [],
      write: [],
    },
    dependsOn: (parseJson(row["depends_on_json"]) as string[] | null) ?? [],
    contractVersions:
      (parseJson(row["contract_versions_json"]) as Record<
        string,
        number
      > | null) ?? {},
    inputHash: str(row["input_hash"], "input_hash"),
    acceptanceCheckIds:
      (parseJson(row["acceptance_check_ids_json"]) as string[] | null) ?? [],
    reviewRequired: flag(row["review_required"]),
    budgets: (parseJson(row["budgets_json"]) as TaskBudgets | null) ?? {
      maxAttempts: 1,
      maxModelTokens: null,
      maxCostUsd: null,
      timeoutSeconds: 600,
    },
    blockReason: optStr(row["block_reason"]),
    publishedRevision: optNum(row["published_revision"]),
    createdAt: str(row["created_at"], "created_at"),
    updatedAt: str(row["updated_at"], "updated_at"),
  };
}

function mapPatch(row: Row): PatchRecord {
  return {
    id: str(row["id"], "id"),
    taskId: str(row["task_id"], "task_id"),
    attempt: num(row["attempt"], "attempt"),
    sha256: str(row["sha256"], "sha256"),
    path: str(row["path"], "path"),
    diffPath: str(row["diff_path"], "diff_path"),
    basePortRevision: num(row["base_port_revision"], "base_port_revision"),
    state: str(row["state"], "state"),
    createdAt: str(row["created_at"], "created_at"),
  };
}

function mapIntegration(row: Row): IntegrationRecord {
  return {
    id: str(row["id"], "id"),
    taskId: str(row["task_id"], "task_id"),
    patchSha256: str(row["patch_sha256"], "patch_sha256"),
    basePortRevision: num(row["base_port_revision"], "base_port_revision"),
    publishedRevision: num(row["published_revision"], "published_revision"),
    idempotencyKey: str(row["idempotency_key"], "idempotency_key"),
    files: (parseJson(row["files_json"]) as string[] | null) ?? [],
    createdAt: str(row["created_at"], "created_at"),
  };
}

function mapValidation(row: Row): ValidationRow {
  return {
    checkId: str(row["check_id"], "check_id"),
    taskId: optStr(row["task_id"]),
    level: str(row["level"], "level"),
    name: str(row["name"], "name"),
    state: str(row["state"], "state"),
    command: optStr(row["command"]),
    engineVersion: optStr(row["engine_version"]),
    inputRevision: str(row["input_revision"], "input_revision"),
    exitStatus: optNum(row["exit_status"]),
    durationMs: optNum(row["duration_ms"]),
    logsPath: optStr(row["logs_path"]),
    artifacts: (parseJson(row["artifacts_json"]) as string[] | null) ?? [],
    reason: optStr(row["reason"]),
    createdAt: str(row["created_at"], "created_at"),
  };
}
