# gm2godot-deep — architecture

`gm2godot-deep` orchestrates a compatibility-first port of a GameMaker LTS 2026 project to Godot
4.7.2. It owns indexing, analysis records, contracts, planning, scheduling, agent roles and tool
permissions, checkpoints/budgets/caching, patch integration, validation and reporting. GM2Godot owns
deterministic conversion (a pinned checkout invoked as a separate process); Pi owns individual agent
sessions and model interactions.

There is **no build output**. The package is ESM (`"type": "module"` in `package.json`), TypeScript is
executed directly by Node type stripping, and `npm run build` is an alias for `npm run typecheck`
(`package.json` scripts). Relative imports carry explicit `.ts` extensions and `tsconfig.json` sets
`noEmit: true`, so what runs and what type-checks are the same files.

## 1. Layer map

| Layer | Directory | Responsibility |
|---|---|---|
| CLI | `src/cli/` | `main.ts` dispatch, `args.ts` command/flag grammar, `output.ts` human-readable rendering, one module per command in `src/cli/commands/` |
| Configuration | `src/config/` | `schema.ts` (zod config schema), `load.ts` (read/validate/override), `resolve.ts` (Python and Godot binary probing) |
| Workspaces | `src/workspaces/` | `paths.ts` directory contract, `workspace.ts` create/open, `guards.ts` path safety, `snapshot.ts` immutable source snapshot, `staging.ts` staging/promotion |
| Adapters | `src/adapters/` | `gm2godot/` (bridge, versions, manifest freshness, exit codes, conversion invocation), `godot/` (probe, headless run, validation report) |
| Indexing | `src/indexing/` | `exclude.ts`, `classify.ts`, `hash.ts`, `units.ts` (analysis units), `inventory.ts` (`inventory.json`) |
| Analysis | `src/analysis/` | `gml/` lexer/macros/scanner, `dependencies.ts`, `cycles.ts`, `graph.ts`, `hazards.ts` |
| Planning | `src/planning/` | `contracts.ts` (ten concerns, seeded from upstream), `reconciler.ts`, `risk.ts`, `tasks.ts` |
| Agents | `src/agents/` | `runtime.ts` (the seam), `roles.ts`, `toolSpecs.ts`, `prompts.ts`, `pi/` (real SDK adapter), `mock/` (deterministic offline runtime) |
| Scheduling | `src/scheduling/` | `machine.ts` state machine, `leases.ts`, `budgets.ts`, `cache.ts`, `retry.ts`, `scheduler.ts`, `analysisPhase.ts`, `pipeline.ts` |
| Integration | `src/integration/` | `allowlist.ts`, `conflicts.ts`, `integrator.ts`, `publish.ts`, `diff.ts`, `review.ts` |
| Validation | `src/validation/` | `levels.ts` vocabulary, `coverage.ts` (A), `structural.ts` (B), `godotRun.ts` (C), `behavioral.ts`/`trace.ts` (D), `presentation.ts` (E), `repair.ts` |
| Evidence | `src/evidence/` | `schemas.ts` (one zod schema per artifact), `store.ts` (atomic writes, reads, staleness validation), `ids.ts` (path encoding) |
| Sandbox | `src/sandbox/` | `backend.ts` (the seam), `select.ts` (fail-closed selection), `sandboxExec.ts`, `docker.ts`, `unsafeLocal.ts`, `env.ts` |
| Storage | `src/storage/` | `db.ts` (`node:sqlite` + pragmas + transactions), `migrations.ts` (ordered schema), `repo.ts` (typed accessors), `types.ts` |
| Utilities | `src/util/` | `json.ts`, `sha256.ts`, `result.ts` (`DeepError`), `log.ts`, `proc.ts`, `ids.ts`, `package.ts` |

Error codes are stable `GM2DEEP-…` strings thrown as `DeepError` (`src/util/result.ts`). A check that
cannot run is `skipped` with a reason, never `passed` (see §6).

## 2. Adapter seams

### Agent runtime (`src/agents/runtime.ts`)

```ts
interface AgentRuntime {
  readonly id: "pi" | "mock";
  readonly simulated: boolean;   // true only for the mock runtime
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

`AgentRunRequest` carries the role, task id, system and user prompts, the tool specs, the
task-scoped workspace roots (`source`/`baseline`/`port`/`task`/`evidence`), the read/write allowlist,
the result schema, turn/time limits, budgets, an `AbortSignal` and host-owned credentials that are
never serialized into an artifact. `AgentRunResult.outcome` is one of
`completed | aborted | timeout | failed | budget_exceeded | no_result`; `result` is validated against
the role's result schema only when the outcome is `completed`.

`Usage` is `{input, output, cacheRead, cacheWrite, costUsd, reported}` —
`reported: false` means the provider did not supply numbers, and the counters are then zero by
construction (`ZERO_USAGE`), never fabricated.

Two implementations satisfy the seam:

- `src/agents/pi/piRuntime.ts` — the real embedded `@earendil-works/pi-agent-core` `Agent`, with
  model resolution, credential handling and event recording.
- `src/agents/mock/mockRuntime.ts` — deterministic and offline: it drives the real host tool handlers
  over the real artifacts, then produces its payload from `src/agents/mock/script.ts`. Every payload
  is `runtime: "mock"`, `simulated: true`, `usage.reported: false`, and the logger is
  `logger.asSimulated()` so lines are prefixed `[simulated]` (`src/util/log.ts`).

`src/agents/roles.ts` defines five fixed roles (`analyst`, `risk_reviewer`, `reconciler`,
`implementer`, `patch_reviewer`), each with a fixed tool list, a single result tool and a turn budget.
No role gets a shell; the only write tool is the implementer's `propose_patch`, which writes only into
the task's patch evidence directory, and `src/agents/toolSpecs.ts` validates every path against the
task allowlist before accepting a payload.

### Converter (`src/adapters/gm2godot/`, `tools/gm2godot_bridge.py`)

`tools/gm2godot_bridge.py` is the only place upstream GM2Godot Python internals are imported. It emits
exactly one JSON document on stdout (all diagnostics go to stderr), exits `3` with
`{"error":"BRIDGE_API_MISMATCH"}` when the pinned API does not match (`ImportError`,
`AttributeError`, unexpected `TypeError`), and the adapter maps that exit to
`GM2DEEP-BRIDGE-API-MISMATCH` rather than degrading. `src/adapters/gm2godot/bridge.ts` spawns it with
`cwd = repoRoot`, `PYTHONDONTWRITEBYTECODE=1` and a scrubbed environment, then validates the payload
with zod (`BridgeInventorySchema`, `GmlApiEntrySchema`).

`src/adapters/gm2godot/versions.ts` holds the supported schema versions and
`assertSupportedFormatVersion`, which is called on every upstream JSON artifact **before any field is
read**. `src/adapters/gm2godot/manifest.ts` implements the freshness predicate (§4 of
`docs/workspace-ownership.md`). `src/adapters/gm2godot/adapter.ts` converts into a fresh
`<workspace>/.staging/baseline-<n>/`, proves the generation fresh, then promotes it into `baseline/`
by rename and freezes it.

### Engine (`src/adapters/godot/`)

`probeGodot(binary, expected)` runs `<binary> --version`, parses the build string with the anchored
`GODOT_VERSION_PATTERN` (`src/adapters/godot/version.ts`) and compares it to the exact expected build
and release prefix (`compareGodotVersion`). A missing or unusable binary returns
`reason: "godot binary not configured or not found"` instead of throwing, so callers can record
`skipped`/`blocked`. `src/adapters/godot/report.ts` reads GM2Godot's own
`gm2godot/godot_validation_report.json`; a `status:"skipped"` report propagates as `skipped`, never as
success.

### Sandbox (`src/sandbox/`)

`backend.ts` defines `SandboxSpec` (`argv`, `cwd`, `mounts`, `env`, `networkAllowed`,
`timeoutSeconds`, `maxOutputBytes`), `SandboxBackend {id, available(), run(spec)}` and
`runSandboxCapture`, so all three backends share one child-process runner (byte capping, deadline,
process-group kill, duration). `select.ts` resolves `sandbox.backend` and fails closed: `docker` when
`docker info` succeeds, else `sandbox-exec` on darwin, else `SandboxUnavailableError`
(`GM2DEEP-SANDBOX-UNAVAILABLE`). `unsafe-local` is never reached by `auto` and requires two explicit
opt-ins. See `docs/sandbox-and-data-handling.md`.

### Evidence (`src/evidence/`)

`schemas.ts` declares one zod schema per artifact, each with a `schemaVersion` literal. `store.ts`
writes atomically (temp file → rename), reads with schema validation, and rejects records that
reference files that do not exist in the inventory, carry a mismatched sha256, or declare a line
beyond the end of a file (`GM2DEEP-EVIDENCE-STALE`). `ids.ts` percent-encodes ids used in artifact
file names (`script:scr_math` → `script%3Ascr_math`).

### Scheduler (`src/scheduling/`)

`machine.ts` is the transition table; `leases.ts` provides task leases, heartbeats and
`reclaimExpired`; `budgets.ts` charges a `budget_ledger` and reports ceiling crossings; `cache.ts`
computes analysis cache keys and invalidations; `scheduler.ts` dispatches with serialization
requirements; `analysisPhase.ts` and `pipeline.ts` wire the phases. Every state change goes through
`TaskMachine.transition`, which writes the state and the `task_events` row in a single transaction
(`src/storage/db.ts` `transact`).

### Integrator (`src/integration/`)

`allowlist.ts` evaluates `PROTECTED_PATHS` **before** the task write allowlist; `conflicts.ts` derives
which tasks must never run concurrently; `integrator.ts` runs the ordered reject/candidate/check/
review/publish steps; `publish.ts` inserts the `integrations` row under the idempotency key
`sha256(taskId|patchSha256|basePortRevision)` before writing files and bumps `port_revisions` after;
`diff.ts` applies recorded file bodies (verifying each pre-image sha256) and derives the review diff.

### Storage (`src/storage/`)

`db.ts` opens `node:sqlite` `DatabaseSync` at `<workspace>/state.sqlite` with
`PRAGMA journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`, and
applies ordered migrations from `migrations.ts` (each in its own transaction, versioned by
`PRAGMA user_version`). `repo.ts` is the only other module that contains SQL.

## 3. Artifact schemas and canonical paths

All artifacts live under `<workspace>/evidence/`. The canonical paths are produced by
`src/evidence/store.ts` (`analysisPathFor`, `reviewPathFor`, `contractPathFor`, `planPathFor`,
`validationPathFor`), `src/indexing/inventory.ts` (`SNAPSHOT_FILENAME`, `INVENTORY_FILENAME`,
`BRIDGE_FILENAME`, `GML_API_FILENAME`), `src/adapters/gm2godot/adapter.ts`
(`BASELINE_EVIDENCE_FILENAME`), `src/integration/diff.ts` (`patchJsonPath`, `patchDiffPath`) and the
transcript path in `src/agents/mock/mockRuntime.ts`.

| Artifact | Canonical path | Schema / producer |
|---|---|---|
| Source snapshot | `evidence/inventory/source-snapshot.json` | `SnapshotRecordSchema` — `src/workspaces/snapshot.ts` |
| Inventory | `evidence/inventory/inventory.json` | `InventoryRecordSchema` — `src/indexing/inventory.ts` |
| Bridge inventory | `evidence/inventory/bridge.json` | `BridgeInventorySchema` — `src/adapters/gm2godot/bridge.ts` |
| GML API manifest | `evidence/inventory/gml-api.json` | `GmlApiEntrySchema[]` — `src/adapters/gm2godot/bridge.ts` |
| Baseline evidence | `evidence/inventory/baseline.json` | `BaselineEvidenceSchema` — `src/adapters/gm2godot/adapter.ts` |
| Analysis record | `evidence/analyses/<unitId>.json` (`:` → `%3A`) | `AnalysisRecordSchema` — `src/evidence/schemas.ts` |
| Analysis review | `evidence/analyses/<unitId>.review.json` | `ReviewRecordSchema` |
| Contract | `evidence/contracts/<concern>.v<N>.json` | `ContractRecordSchema` |
| Plan | `evidence/plans/plan.v<N>.json` | `PlanRecordSchema` |
| Patch payload | `evidence/patches/<taskId>/<attempt>.patch.json` | `PatchRecordPayloadSchema` |
| Patch diff | `evidence/patches/<taskId>/<attempt>.patch.diff` | derived by `renderUnifiedDiff` (`src/integration/diff.ts`) |
| Validation result | `evidence/validation/<checkId>.json` | `ValidationResultSchema` |
| Transcript | `evidence/reports/transcripts/<taskId>.<attempt>.jsonl` | `AgentEventRecord` lines (`src/agents/runtime.ts`) |
| Report | `evidence/reports/report.json`, `evidence/reports/report.md` | written by the report phase (`src/scheduling/pipeline.ts` imports `src/evidence/report.ts`) |

`AnalysisRecordSchema` is the contract between the analyst role and everything downstream; its keys
are `schemaVersion, unitId, unitKind, sourceSnapshotId, baselineId, sourcePaths, generatedOutputs,
converterDiagnostics, purpose, behavior, lifecycle, ownedState, sharedState, inputs, sideEffects,
dependencies, hazards, strategy, strategyRationale, acceptanceScenarios, assumptions, uncertainties,
blockers, evidence, producedBy`. Role payload schemas are the same records with host-owned identity
fields removed (`src/agents/roles.ts`), so a model may describe what it found but never assert which
unit it is or what it ran against.

The trace interface (`TraceFileSchema`) records `provenance` ∈
`observed_original_runtime | source_derived | synthetic`, a `randomness` mode, a `timing` mode and an
event sequence; level D compares positionally and writes the provenance into the check name
(`src/validation/behavioral.ts`).

## 4. Task state machine

`src/scheduling/machine.ts` defines the complete transition table. Any edge not listed is a
programming error: `TaskMachine.transition` throws `IllegalTransitionError`
(`GM2DEEP-ILLEGAL-TRANSITION`), and the state write plus the `task_events` append happen in one
transaction.

| From | Legal targets |
|---|---|
| `DISCOVERED` | `ANALYZED`, `BLOCKED`, `CANCELLED` |
| `ANALYZED` | `PLANNED`, `BLOCKED`, `CANCELLED` |
| `PLANNED` | `READY`, `BLOCKED`, `CANCELLED` |
| `READY` | `RUNNING`, `BLOCKED`, `CANCELLED` |
| `RUNNING` | `IMPLEMENTED`, `FAILED`, `BLOCKED`, `CANCELLED` |
| `IMPLEMENTED` | `VALIDATING`, `CANCELLED` |
| `VALIDATING` | `ACCEPTED`, `REPAIR_REQUIRED`, `FAILED`, `BLOCKED`, `CANCELLED` |
| `REPAIR_REQUIRED` | `RUNNING`, `BLOCKED`, `FAILED`, `CANCELLED` |
| `ACCEPTED` | `READY` (only via a recorded invalidation) |
| `BLOCKED`, `FAILED`, `CANCELLED` | `READY` (only via an explicit retry/resume) |

`REASON_REQUIRED` marks the four edges into `READY` from a terminal-ish state
(`ACCEPTED->READY`, `BLOCKED->READY`, `FAILED->READY`, `CANCELLED->READY`): taking one without a
`reason` throws `GM2DEEP-TRANSITION-REASON-REQUIRED`, so a silent re-run can never look like
progress. Entering `RUNNING`/`REPAIR_REQUIRED` increments the attempt in the same transaction.

## 5. Analysis cache key

`analysisCacheKey` (`src/scheduling/cache.ts`) is
`sha256(canonicalJson({unitId, sourceHashes, dependencyEdges, baselineId, gm2godotVersion,
godotVersion, analysisSchemaVersion, analyzerVersion, promptVersion, model, analysisUnitKinds}))`,
with `dependencyEdges` sorted by `to` then `kind` and each edge carrying the contract versions in
effect for it. `ANALYSIS_SCHEMA_VERSION = 1`, `ANALYZER_VERSION = "1"` and `PROMPT_VERSION = "1"`
(`src/agents/prompts.ts`) are part of the key, so a scanner change, a schema change or a prompt change
invalidates every cached record.

A contract version bump changes the key of every unit whose dependency edges touch that concern,
even when the unit's own `.gml` is unchanged. `invalidateForContractChange(repo, concern,
fromVersion, toVersion)` records a `contract_change` invalidation per bound unit, deletes those
units' cache entries and returns the unit ids the scheduler must re-key to `READY`.

## 6. Validation levels and the `passed` proof

`src/validation/levels.ts` is the single vocabulary: levels `A`–`E`, states
`passed | failed | skipped | inconclusive`, and constructors that are the only way to make a result.
A `passed` record is structurally impossible to fake: `passedResult` throws
`GM2DEEP-CHECK-NOT-EXECUTED` unless a non-empty `command`, a non-empty `engineVersion` and a numeric
integer `exitStatus` are all present. `passedInProcessResult` (level A coverage, the static half of
level B) requires a command and an exit status and deliberately offers no way to attach an engine
version, so an in-process check can never claim an engine ran it. `skippedResult` and
`inconclusiveResult` require a non-empty reason.

| Level | Module | What it is |
|---|---|---|
| A | `src/validation/coverage.ts` | Every inventory file and unit carries exactly one disposition (`analyzed, retained, repaired, replaced, blocked, deterministic_only`, or `excluded(<reason>)`). Reported as a coverage percentage of files accounted for. |
| B | `src/validation/structural.ts` | `structural-static` parses `project.godot`, `.tscn`/`.tres` references and `preload`/`load` literals without an engine; `structural-gm2godot` runs the pinned converter's `validate` and inherits its verdict (a skipped report stays skipped). |
| C | `src/validation/godotRun.ts` | Headless Godot run with captured, ANSI-stripped output; any line matching `^(ERROR\|SCRIPT ERROR\|SHADER ERROR)` fails the check even on exit 0 (`runGodotHeadless`, `firstEngineErrorLine`). |
| D | `src/validation/behavioral.ts`, `trace.ts` | Steps the candidate under a scenario harness and compares the single `DEEP_TRACE <json>` line positionally against a recorded expectation. |
| E | `src/validation/presentation.ts` | Visual, audio, control and export checks; on a headless host they are `skipped` with reasons and are never derived from a successful headless boot. |

The report keeps **file coverage, test coverage and behavioural verification as three separate
summary numbers and never combines them into a single "compatibility percentage"** — whether a file
was processed says nothing about whether the port behaves correctly (`src/validation/coverage.ts`).

## 7. Why zod and `node:sqlite`

- **zod** is the single declaration from which both the runtime validator and the static type of every
  artifact are derived. Artifacts are JSON written by models and by subprocesses, so they must be
  parsed, not trusted; hand-written validators for ~12 records would be a second, drifting source of
  truth. Config parsing (`src/config/schema.ts`), every evidence record (`src/evidence/schemas.ts`)
  and every bridge payload (`src/adapters/gm2godot/bridge.ts`) go through zod.
- **`node:sqlite` (`DatabaseSync`)** needs no native module, no ORM and no migration framework, and
  keeps the run state in one file (`<workspace>/state.sqlite`) with real transactions — which the
  state machine depends on (state change + event append atomically). Node prints
  `ExperimentalWarning: SQLite is an experimental feature`; that is documented and not suppressed.

## 8. Compiled extension entry point

`npm run build` typechecks source and emits JavaScript into `dist/` using `tsconfig.build.json`.
The release bundle contains this compiled code, pinned Node, locked production dependencies and
schemas. End users need no TypeScript loader, Node installation or checkout. Development tests can
still run TypeScript directly with Node 22.19 or newer. The host entry point is `dist/host/main.js`.

## 9. What evidence validation does not prove

`validateAnalysisEvidence` (`src/evidence/store.ts`) checks that every declared source path and
evidence location exists in the inventory with a matching sha256, that every declared generated output
is an output of that unit with the baseline's hash, and that every declared line is inside the file.
**Evidence validation prevents fabricated or stale references; it does not prove a claim true.** It
cannot tell whether a symbol was described correctly, only that the record is not built on files that
never existed or have since changed.
