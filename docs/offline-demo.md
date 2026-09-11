# Offline demonstration

The end-to-end demo runs the real pipeline against the synthetic
`fixtures/gm-projects/counter` fixture with the real pinned GM2Godot checkout and the real Godot
binary, and with the mock agent runtime so nothing needs network or credentials.

`examples/workspace/` is **produced by running the demo and is not committed**: the `.gitignore`
pattern `workspace/` matches any directory named `workspace` at any depth, so `examples/workspace/`
(and its `state.sqlite`) is ignored. Verified:

```sh
$ git check-ignore -v examples/workspace/state.sqlite examples/workspace/port
.gitignore:2:workspace/	examples/workspace/state.sqlite
.gitignore:2:workspace/	examples/workspace/port
```

`examples/deep-convert.config.json` is the committed, validated example configuration
(`agent.runtime: "mock"`, the machine's real GM2Godot checkout/Python and Godot binary paths). It is
a reference for the values the demo passes on the command line; `init` writes the workspace's own
`<workspace>/deep-convert.config.json`.

## 0. Re-verify the pins

```sh
PYTHONDONTWRITEBYTECODE=1 \
  /Users/infi/Documents/Github/.gm2godot-campaign-venv/bin/python \
  /Users/infi/Documents/Github/GM2Godot/main.py --version          # GM2Godot 0.7.74
git -C /Users/infi/Documents/Github/GM2Godot rev-parse HEAD        # 38b364855f06e971d2676b921fd300e1f40f076a
/Applications/Godot.app/Contents/MacOS/Godot --version             # 4.7.2.stable.official.ed1daf0bf
```

If the GM2Godot version is not in `gm2godot.expectedVersions` the bridge refuses with
`GM2DEEP-UPSTREAM-UNSUPPORTED-SCHEMA` / `GM2DEEP-BRIDGE-API-MISMATCH` rather than continuing.

## 1. Init

```sh
node src/cli/main.ts init --source fixtures/gm-projects/counter \
  --workspace examples/workspace \
  --gm2godot-checkout /Users/infi/Documents/Github/GM2Godot \
  --gm2godot-python /Users/infi/Documents/Github/.gm2godot-campaign-venv/bin/python \
  --godot-bin /Applications/Godot.app/Contents/MacOS/Godot --runtime mock
```

`init` probes the toolchain first and refuses to write a config whose pinned versions do not match,
unless `--force` is passed. Expected observables:

- the workspace layout from `docs/workspace-ownership.md` §1 exists, plus
  `examples/workspace/deep-convert.config.json`;
- `examples/workspace/source/` is byte-identical in hash to the fixture and read-only (files `0o444`,
  directories `0o555`, `src/workspaces/snapshot.ts` `freezeTree`);
- `evidence/inventory/source-snapshot.json` lists every kept file with `sha256`/`bytes`/`mode` and
  every excluded entry with a reason.

### Doctor

```sh
node src/cli/main.ts doctor --workspace examples/workspace
```

Expected to show, verbatim: `GM2Godot 0.7.74 (commit 38b3648…)`, the Python executable and its
version, `Godot 4.7.2.stable.official.ed1daf0bf (matches expected)` (or a mismatch warning), and
`sandbox: sandbox-exec (available)` — docker's CLI exists but its daemon is not running, so the
`auto` selection resolves to `sandbox-exec` (`src/sandbox/select.ts`).

## 2. Plan (no implementation)

```sh
node src/cli/main.ts run --workspace examples/workspace --through plan
```

`run` without `--execute` stops after the plan phase, so implementation never starts implicitly
(`src/cli/args.ts`; `src/scheduling/pipeline.ts` gates the implement/validate phases on
`options.execute`). Expected observables:

- **inventory**: `evidence/inventory/inventory.json` plus `bridge.json` and `gml-api.json`
  (`src/indexing/inventory.ts`); the snapshot is re-verified first and a drifted source raises
  `GM2DEEP-SOURCE-SNAPSHOT-CHANGED`.
- **baseline**: a real GM2Godot generation promoted into `examples/workspace/baseline/` from
  `.staging/baseline-<n>/`, with `evidence/inventory/baseline.json` recording `exitCode: 0` and the
  attempt state `partial` (the fixture ships no `options/macos/icons` art, so `game_icon` is skipped —
  see `docs/limitations.md` §8). `baseline/gm2godot/conversion_diagnostics.json` is untouched upstream
  evidence. A generation that is not fresh raises `GM2DEEP-BASELINE-NOT-FRESH`; `--allow-stale-baseline`
  accepts it but records it as non-fresh.
- **analyze**: one analysis record per analysis-required unit under `evidence/analyses/`; the
  `script:*:scr_state` record carries `unresolved` entries for `script_execute` and
  `asset_get_index`, and both `scr_math` and `scr_state` records reference the same cycle group
  (`fixtures/gm-projects/counter/README.md`, properties 3 and 4).
- **plan**: `evidence/contracts/` holds the seeded versioned contracts (ten concerns, each rule's
  `upstreamBasis` citing a real baseline file, or `basis: "unresolved"` with `policy.needsReview`);
  `evidence/plans/plan.v1.json` has tasks whose `allowlist.write` contains only generated output
  paths.

## 3. Execute

```sh
node src/cli/main.ts run --workspace examples/workspace --execute --max-workers 2
```

Expected observables:

- tasks move through `READY → RUNNING → IMPLEMENTED → VALIDATING → ACCEPTED` via
  `TaskMachine.transition`, with state and `task_events` written in one transaction
  (`src/scheduling/machine.ts`);
- exactly one task with a deliberately injected defect fails level D, is repaired once (the mock's
  `MOCK_DEFECT_MARKER` first-attempt defect — `docs/limitations.md` §7), and reaches `ACCEPTED`;
- `port_revisions` shows one row per published task plus the seeded revision 0, and each
  `integrations` row is keyed by `sha256(taskId|patchSha256|basePortRevision)`, so a resumed run cannot
  apply a patch twice;
- rejected patches leave `port/` byte-identical (the candidate tree under
  `tasks/<taskId>/attempt-<n>/candidate/` is removed in a `finally` block, `src/integration/integrator.ts`).

## 4. Status

```sh
node src/cli/main.ts status --workspace examples/workspace
```

Human-readable tables (`src/cli/output.ts` `renderTable`/`renderKeyValues`); `--json` prints the raw
artifact.

## 5. Report

```sh
node src/cli/main.ts report --workspace examples/workspace --format md
```

Expected `evidence/reports/report.md` contents:

- runtime `mock (deterministic, no model exercised)` — never a claim that a model ran;
- sandbox `sandbox-exec (available)`;
- level A coverage as a count/percentage of accounted files;
- levels B and C as records with a real command, engine build string and exit status (the machine's
  Godot matches the pinned build, so they run for real);
- level E skipped with reasons (`no renderer in headless verification`, …);
- three separate summary numbers for **file coverage**, **test coverage** and **behavioural
  verification** — never combined into a compatibility percentage;
- model usage only where reported, with `reported: false` rendered as "provider did not report usage".

## 6. Determinism

Running steps 1–5 a second time into a fresh workspace (`examples/workspace-2`) yields identical
artifact hashes apart from timestamps: the mock runtime is deterministic
(`src/agents/mock/mockRuntime.ts`) and the analysis cache key is a pure function of the unit sources,
dependency edges, baseline id, tool versions, prompt version and model
(`src/scheduling/cache.ts`).

## 7. Cache invalidation

```sh
node src/cli/main.ts cache --workspace examples/workspace --clear
node src/cli/main.ts run   --workspace examples/workspace --through plan
```

Clearing the cache forces re-analysis instead of reusing stale records (`AnalysisCache.clear`,
`src/scheduling/cache.ts`). Note that `run --through plan` without `--execute` stops before
implementation, so this only re-runs inventory/baseline/analyze/plan.
