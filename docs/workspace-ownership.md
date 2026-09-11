# Workspace ownership

This document is the directory contract: who may write where, what is immutable and how that is
enforced, and which parts of a converted project the upstream converter owns.

## 1. Directory contract

`createWorkspace` (`src/workspaces/workspace.ts`) creates exactly the directories listed in
`WORKSPACE_DIRECTORIES` (`src/workspaces/paths.ts`); `openWorkspace` refuses a root that is missing any
of them (`GM2DEEP-WORKSPACE-INCOMPLETE`).

```
<workspace>/
  deep-convert.config.json      # validated config (src/config/schema.ts)
  state.sqlite                  # run/task/lease/budget/cache/integration state
  source/                       # frozen copy of the GameMaker project (read-only)
  baseline/                     # frozen GM2Godot generation (read-only)
  port/                         # the mutable Godot port under construction
  tasks/                        # per-task candidate trees: tasks/<taskId>/attempt-<n>/candidate/
  validation/                   # per-check project copies and run logs
  .staging/                     # baseline-<n>/ staging conversions, removed on promotion
  evidence/
    inventory/                  # source-snapshot.json, inventory.json, bridge.json, gml-api.json, baseline.json
    analyses/                   # <unitId>.json, <unitId>.review.json
    contracts/                  # <concern>.v<N>.json
    plans/                      # plan.v<N>.json
    patches/                    # <taskId>/<attempt>.patch.json and .patch.diff
    validation/                 # <checkId>.json
    reports/                    # report.json, report.md
    reports/transcripts/        # <taskId>.<attempt>.jsonl
```

`assertDisjoint` refuses a workspace nested inside the source project and a source project nested
inside the workspace (`GM2DEEP-PATH-NESTED-WORKSPACE`), because either nesting would make a copy of
the source mutable through the other side.

Every path an untrusted value is joined to goes through `src/workspaces/guards.ts`:
`assertSafeRelativePath` (no absolute path, drive letter, `..` segment or NUL), `assertContained`
(lexical + realpath containment), `assertNoEscapingLinks` (a symlink whose target resolves outside
the root is fatal) and `assertNotInside`. The corresponding codes are `GM2DEEP-PATH-TRAVERSAL`,
`GM2DEEP-PATH-LINK-ESCAPE` and `GM2DEEP-PATH-NESTED-WORKSPACE`.

## 2. Immutability of `source/` and `baseline/`

**`source/`** is copied once by `snapshotSource` (`src/workspaces/snapshot.ts`), with excluded entries
recorded by reason, and then frozen: `freezeTree` `chmod`s files to `0o444` and directories to
`0o555`, deepest first, so nothing in the tree can be edited in place. The snapshot identity is a pure
function of the kept `(path, sha256)` set:

```
snapshotId = "sha256:" + sha256OfEntries(sorted (path, sha256) pairs)
```

`evidence/inventory/source-snapshot.json` records `schemaVersion, originalSourcePath, snapshotId,
createdAt, entries[{path, sha256, bytes, mode}], excluded[{path, reason}]`. `verifySnapshot(snapshotDir,
expected)` recomputes the whole identity and throws `GM2DEEP-SOURCE-SNAPSHOT-CHANGED` on any missing,
unexpected or drifted file (the error detail names the missing, unexpected and drifted paths plus the
expected and observed ids). The pipeline calls it before inventory is rebuilt
(`src/scheduling/pipeline.ts`, `phaseInventory`), so a source that changed mid-run stops the run
rather than producing mixed evidence. The snapshot is also unreachable by any patch: `source/**` is in
`PROTECTED_PATHS` (§5).

**`baseline/`** is written by promotion, never in place. `generateBaseline`
(`src/adapters/gm2godot/adapter.ts`) copies the frozen snapshot into
`<workspace>/.staging/baseline-<n>/source`, invokes the converter against
`.staging/baseline-<n>/godot`, verifies the generation, and only then calls `promoteDirectory`
(`src/workspaces/staging.ts`: `rmSync(destination)` + `renameSync(staged, destination)`) and
`freezeTree(baseline)`. `baseline/**` is likewise in `PROTECTED_PATHS`, so no patch may touch it.

## 3. Converter-owned roots

GM2Godot owns the paths it regenerates. Read from the pinned checkout
`/Users/infi/Documents/Github/GM2Godot/src/conversion/project_godot.py`:

- `MANAGED_OUTPUT_DIRECTORIES`: `addons/gm2godot_extensions`, `fonts`, `gm2godot`, `included_files`,
  `notes`, `objects`, `particles`, `particlesystems`, `paths`, `rooms`, `scripts`, `sequences`,
  `shaders`, `sounds`, `sprites`, `tilesets`
- `MANAGED_OUTPUT_FILES`: `default_bus_layout.tres`, `icon.ico`, `icon.png`
- `project.godot` is **jointly managed**: the converter writes the GameMaker-derived settings into it,
  and the port may also edit it, which is why `project.godot` and the other jointly-owned runtime
  paths are serialized through a single-writer mutex (`SHARED_OUTPUT_MUTEX_PATHS` in
  `src/analysis/cycles.ts`: `project.godot`, `default_bus_layout.tres`, `gm2godot/gml_runtime.gd`,
  `gm2godot/managers`, `gm2godot/gml_script_registry.gd`, `gm2godot/gml_asset_registry.gd`).

`listManagedOutputs(baselineDir)` (`src/adapters/gm2godot/manifest.ts`) re-derives the converter-owned
file set from `conversion_manifest.json`'s `generation_inventory.entries` (path, kind, owner class and
name, byte count, sha256, mode) rather than trusting a directory walk, so the port inherits converter
provenance from the converter's own record.

## 4. The freshness predicate

`readBaselineProvenance` (`src/adapters/gm2godot/manifest.ts`) is the single most correctness-critical
predicate in the system. A manifest is a **fresh** generation only when all of the following hold:

1. the manifest parses against `ConversionManifestSchema` with `format_version: 2` and its
   `generation_inventory.format_version: 1` (checked by `assertSupportedFormatVersion` before use);
2. `conversion_attempt.json` is present, parses with `format_version: 1`, and its
   `canonical_manifest` is `{path: "gm2godot/conversion_manifest.json", status: "updated",
   updated: true, current_output: "verified", sha256: "sha256:" + sha256(manifest bytes)}` — the
   digest must equal the actual manifest bytes;
3. the attempt state is `success` or `partial` (only those can describe a generation this run wrote);
4. the generation inventory lists at least one entry.

Any failure appends a human-readable reason and `fresh` is `false`; `adapter.ts` then fails the
baseline with `GM2DEEP-BASELINE-NOT-FRESH` (unless the caller explicitly passed
`allowStaleBaseline`) and records the attempt as evidence.

`status:"preserved"` is the important case: it means an **older** generation survived a failed or
cancelled run. It never describes the destination, so it is never treated as success. A `partial`
attempt with `status:"updated"` is a legitimate partial baseline and is carried into the report as
`partial`, not as `success`.

## 5. Patches and stale inputs

`src/integration/allowlist.ts` evaluates `PROTECTED_PATHS` **before** the task write allowlist:

```
tests/**  fixtures/**  evidence/**  source/**  baseline/**  deep-convert.config.json  bin/**  src/**
```

A patch touching any of these is rejected with `GM2DEEP-PATCH-PROTECTED-PATH`; a path outside the task
write allowlist is `GM2DEEP-PATCH-OUTSIDE-ALLOWLIST` (or `GM2DEEP-PATCH-DELETE-OUTSIDE-ALLOWLIST` for
a delete). Unrepresentable paths fail closed (treated as protected). This is what makes it impossible
for a patch author to weaken its own acceptance tests, rewrite expected results, or edit the frozen
snapshot, the baseline or the harness.

`integrateTask` (`src/integration/integrator.ts`) rejects a patch whose inputs no longer match, with
`GM2DEEP-PATCH-STALE-INPUT` naming the drifted value, when:

- the patch's `taskId` is not the task being integrated;
- its `contractVersions` differ from the contract versions in effect;
- its `inputHash` differs from the recomputed unit input hash;
- its `baselineId` differs from the current baseline id.

A patch based on a port revision that has since moved is rejected with `GM2DEEP-PATCH-STALE-BASE`; the
patch is re-planned, never applied to a tree it was not derived from. The candidate tree is built by
copying `port/` to `tasks/<taskId>/attempt-<n>/candidate`, applying the recorded file bodies (each
pre-image sha256 verified, `src/integration/diff.ts`), running the checks, and removing the candidate
in a `finally` block in every path — so a rejected attempt leaves `port/` byte-identical.

Publication is idempotent by construction: `publishPatch` (`src/integration/publish.ts`) keys the
`integrations` row by `idempotency_key = sha256(taskId|patchSha256|basePortRevision)` (a unique index
in `src/storage/migrations.ts`), inserts the row **before** writing files, and writes the files into
`port/` under the single-writer mutex before bumping `port_revisions`. A duplicate integration is a
no-op returning the original row, so a resumed run cannot apply a patch twice.

## 6. Provenance split

- **Upstream conversion evidence** stays under `baseline/gm2godot/` exactly as the converter wrote it
  (`conversion_manifest.json`, `conversion_attempt.json`, `conversion_diagnostics.json`, source maps,
  `architecture_policy.json`). Nothing in this repository rewrites those files; the freshness
  predicate reads them. The orchestrator's own record of the baseline is a separate artifact,
  `evidence/inventory/baseline.json` (`BaselineEvidenceSchema`, schemaVersion 1), which records
  `baselineId, generatedAt, gm2godot{version,commit,checkout,python,pythonVersion,platform,groups,only},
  exitCode, state, outcome, summaryLine, manifestSha256, attemptSha256,
  generationInventoryFormatVersion, entryCount, preservedGeneration, reasons, godotProjectDir,
  reportsDir`.
- **The port's provenance** is its own: every published change adds a row to `port_revisions`
  (`revision, created_at, task_id, integration_id, files_json`) and an `integrations` row. Revision 0
  is seeded by the migration, so "the port as generated" is revision 0 and each accepted task is a
  later revision. A patch can therefore always be attributed either to the converter (revision 0 /
  `baseline/`) or to a specific task integration.
