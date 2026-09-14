# Limitations

The honest list. Nothing here is a defect to be papered over; each item is a boundary the report must
carry rather than hide.

## 1. No complete GML call graph is claimed

The scanner (`src/analysis/gml/scanner.ts`) is deliberately conservative and single-pass. Dynamic
lookups (`script_execute`, `asset_get_index`, `variable_instance_get/set`,
`variable_struct_get/set`, `method(...)`, string-built asset or script names, computed `with`
targets, and any call whose callee matches no known script, object, extension function or GML API
entry) are recorded as `unresolved` with their evidence location — never dropped and never guessed.
`script_execute` is unresolved because "script_execute target is not statically known" and
`asset_get_index` because "asset_get_index argument is not a literal asset name"
(`src/analysis/gml/scanner.ts`). Macros that do not resolve to a literal stay
`unresolvedMacroNames` (`src/analysis/gml/macros.ts`).

Consequently: unresolved dynamic references are reported as **uncertainty** in the unit record and in
the report. They are not silently resolved by inference, and a missing edge is never evidence that no
edge exists.

## 2. Level D on the shipped fixture uses a synthetic expectation

The behavioral check names the expectation's provenance in the check name and reason, verbatim
(`src/validation/behavioral.ts`: `level D behavioural — scenario trace comparison (expected trace
provenance: synthetic)`), and `TraceFileSchema` (`src/evidence/schemas.ts`) admits exactly
`observed_original_runtime | source_derived | synthetic`. The fixture's expectation,
`fixtures/traces/counter_expected.json`, is `synthetic`: it is produced from the generated baseline of
the synthetic fixture, not from an original game, and its `note` says so. A synthetic expectation is
never presented as observed original behaviour. If the expectation file is absent, level D is
`skipped` with the reason `no recorded expectation at …, so there is nothing to compare against` —
never `passed`.

Related: equal seeds are not assumed to produce equal behaviour across engines. Randomness is
controlled by the scenario calling a fixed seed and stepping a fixed count
(`randomness.mode: "fixed_seed"`, `timing.mode: "step_count"` in the trace schema) rather than by
relying on frame timing.

## 3. Presentation and export checks are skipped on a headless host

`src/validation/presentation.ts` records level E visual, audio, control and export checks as
`skipped` with the reasons `no renderer in headless verification`, `no audio device` and
`no export template installed` (or an explicit "…but no … verification is implemented"). None of them
may ever be `passed` here, and a successful headless boot is never derived into evidence for any of
them.

## 4. `node:sqlite` prints an experimental warning

`src/storage/db.ts` uses `node:sqlite`'s `DatabaseSync`. Node emits
`ExperimentalWarning: SQLite is an experimental feature` on first use. That warning is documented
here and deliberately not suppressed.

## 5. Live providers and usage

The hosted client defaults to OpenCode automatic free selection and explicitly requests consent
before research. The developer CLI retains its mock default. Provider connection or authentication
failures pause a job; they are not passing research. Usage absent from a provider remains unknown.
Native coding agents may not expose monetary costs or enforce a precise per-response token cap.
See [provider contracts](providers.md) for current controls and limitations.

## 6. Staging and process isolation

Hosted candidate copies preserve source and baseline, but filesystem staging is not an execution
sandbox. Coding agents receive guarded source/documentation tools and structured candidate proposals;
the adapters disable native tools. Third-party agent binaries and Godot still execute locally.
The legacy standalone CLI has separate optional sandbox backends; those do not imply isolation for
the hosted extension. Engine and behavioral results remain separate from file accounting.

## 7. The mock runtime injects one documented first-attempt defect

So that the repair loop is exercised end to end without a model, the mock injects a deterministic
defect into the first attempt of a `repair_generated` task: `MOCK_DEFECT_MARKER =
"deep-convert[mock] deliberate first-attempt defect"` (`src/agents/mock/script.ts`,
`mockDefectLine`), appended as a Godot line that mutates the counter and runs on `_ready`. The second
attempt removes it again.

**This defect is a property of the simulator, not an observation about the port.** No mock payload
invents game semantics: statements are templated over symbols actually found on disk, and every
payload carries `runtime: "mock"`, `simulated: true` and `usage.reported: false`, with logger lines
prefixed `[simulated]` (`src/util/log.ts` `asSimulated`). A mock run must never be read as evidence
about the GameMaker project or about the converted port.

## 8. The fixture's sprite ships with no `options/macos/icons` art

`options/macos/icons/` is absent from `fixtures/gm-projects/counter`, so the converter's icon step
reports `Icon directory not found` and the `game_icon` resource is **skipped** (not failed). The
conversion of the fixture is `partial` with zero error and warning diagnostics: converters
`requested=15, executed=15, completed=15, skipped=0, failed=0`, resources
`requested=16, executed=16, completed=15, skipped=1, failed=0` (recorded in
`fixtures/gm-projects/counter/README.md`). The partiality is carried into the report as partial, not
as success.

## 9. GM2Godot needs an absolute `--gm-project` path

Pinned GM2Godot 0.7.74 silently discovers zero `options/` entries when the project path is relative
(`load_gamemaker_project_manifest` returns 0 options for `fixtures/gm-projects/counter` and 21 for the
same directory given absolutely). A relative path still exits 0, but the `project_settings` step logs
"No GameMaker main or target-platform options metadata was found.", the resource `skipped` count rises
to 2 and `project.godot` receives no GameMaker-derived settings. `generateBaseline`
(`src/adapters/gm2godot/adapter.ts`) therefore resolves every path it hands to the converter
(`resolve(allocateStagingDir(...))`), and every verification command must pass an absolute
`--gm-project`. The behaviour and the observed diagnostics are recorded in
`fixtures/gm-projects/counter/README.md` (deviation 2).

Related upstream behaviour, also recorded there: GM2Godot refuses a redirected report-directory root,
so on macOS `/tmp/...` fails while the unredirected `/private/tmp/...` succeeds. GM2Godot is not
patched for either behaviour.

## 10. `baselineId` is not reproducible across two workspaces

`baselineId` is defined as `sha256` of the bytes of `gm2godot/conversion_manifest.json`
(`src/adapters/gm2godot/manifest.ts`), which is the identity a patch and an analysis record are bound to.

Two conversions **from the same source path** are byte-identical — verified on the pinned converter:
`conversion_manifest.json`, `conversion_attempt.json` and every `.gmlmap.json` produce empty `diff`, and
the manifest contains no absolute paths of its own (`grep -c '/private/tmp' <manifest>` → `0`).

The manifest is nevertheless not reproducible across two *workspaces*, because each workspace converts from
its own staging copy (`<workspace>/.staging/baseline-<n>/source`) and the converter's per-file source maps
embed the absolute path of the project it was pointed at:

```
objects/obj_counter/obj_counter.gd.gmlmap.json
  "source_path": null                                  <- top level is null for object scripts
  entries[0].source_path:
  "/Users/infi/Documents/Github/gm2godot-deep/fixtures/gm-projects/counter/objects/obj_counter/Create_0.gml"
```

`conversion_manifest.json` digests every generated file, `.gmlmap.json` included. A different staging path
therefore changes those digests, which changes the manifest bytes, which changes `baselineId`. This is not
fixable from this repository without rewriting upstream output, and it is not a defect: `baselineId` names
one specific generation, and patches are deliberately rejected when the generation they were written
against has changed (`GM2DEEP-PATCH-STALE-INPUT`).

Consequence for the determinism check: `tests/e2e/offline-workflow.test.ts` compares every artifact across
two runs with exactly two run-specific fields normalised — `baselineId` (and the same field inside each
analysis record) and timestamps. Everything else, including the inventory, the unit set, the confirmed and
inferred dependency edges, the contracts, the plan, the task rows, the patches and the check results, is
compared byte-for-byte.

`src/indexing/inventory.ts` copes with the null/absolute `source_path` by normalising both the top-level
value and every `entries[].source_path` against the project's real source files (longest suffix match wins),
which is the only form that survives conversion from a staging copy.

## Hosted resume and availability

A saved job resumes against its original source and baseline hashes. Changed inputs require a fresh
job; selective cross-job reuse is not yet implemented. Automatic free eligibility is checked against
current official metadata before dispatch. A disappeared model or inaccessible pricing can pause
research even if a prior evaluation passed. No paid fallback occurs.
