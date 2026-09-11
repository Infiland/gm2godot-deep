/**
 * Ordered migrations. Each entry is applied once, inside one transaction, and `PRAGMA user_version`
 * records how far the database has been advanced. Never edit an applied migration — append.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  through_phase TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  execute INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE units (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  analysis_required INTEGER NOT NULL,
  deterministic INTEGER NOT NULL,
  state TEXT NOT NULL,
  strategy TEXT,
  risk_level TEXT,
  risk_json TEXT,
  group_id TEXT,
  source_hashes_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  unit_ids_json TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  strategy TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  allowlist_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  contract_versions_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  acceptance_check_ids_json TEXT NOT NULL,
  review_required INTEGER NOT NULL,
  budgets_json TEXT NOT NULL,
  block_reason TEXT,
  published_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  attempt INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX task_events_task ON task_events (task_id, id);

CREATE TABLE leases (
  task_id TEXT PRIMARY KEY,
  owner TEXT,
  acquired_at TEXT,
  expires_at TEXT
);

CREATE TABLE patches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  diff_path TEXT NOT NULL,
  base_port_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, sha256)
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  patch_sha256 TEXT NOT NULL,
  base_port_revision INTEGER NOT NULL,
  published_revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, patch_sha256, base_port_revision)
);

CREATE TABLE analyses (
  unit_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  risk_level TEXT,
  strategy TEXT,
  produced_by_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE contracts (
  concern TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (concern, version)
);

CREATE TABLE contract_bindings (
  concern TEXT NOT NULL,
  version INTEGER NOT NULL,
  unit_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  PRIMARY KEY (concern, version, unit_id, rule_id)
);

CREATE TABLE budget_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  reported INTEGER NOT NULL
);
CREATE INDEX budget_ledger_run ON budget_ledger (run_id);
CREATE INDEX budget_ledger_task ON budget_ledger (task_id);

CREATE TABLE cache_entries (
  key TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX cache_entries_unit ON cache_entries (unit_id);

CREATE TABLE validation_results (
  check_id TEXT PRIMARY KEY,
  task_id TEXT,
  level TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  command TEXT,
  engine_version TEXT,
  input_revision TEXT NOT NULL,
  exit_status INTEGER,
  duration_ms INTEGER,
  logs_path TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX validation_results_task ON validation_results (task_id);

CREATE TABLE port_revisions (
  revision INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT,
  integration_id TEXT,
  files_json TEXT NOT NULL
);

CREATE TABLE invalidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  concern TEXT,
  from_version INTEGER,
  to_version INTEGER,
  unit_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE baseline_attempts (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  state TEXT NOT NULL,
  fresh INTEGER NOT NULL,
  detail_json TEXT NOT NULL
);

INSERT INTO port_revisions (revision, created_at, task_id, integration_id, files_json)
VALUES (0, '1970-01-01T00:00:00Z', NULL, NULL, '[]');
`,
  },
];
