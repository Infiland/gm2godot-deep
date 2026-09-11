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

## 5. A real Pi run needs network and credentials

The default runtime is the mock (`agent.runtime` defaults to `"mock"`, `src/config/schema.ts`). A
live Pi run requires network access and provider credentials resolvable at execution time
(`~/.pi/agent/auth.json` or `PI_CODING_AGENT_DIR`). When no credential resolves, that path reports
`skipped` with the reason and the report says the live-provider path is unverified — it is never
reported as passing. When usage is not reported by the provider, `Usage.reported` is `false`, the
counters are zero by construction (`ZERO_USAGE`, `src/agents/runtime.ts`) and the report renders
"provider did not report usage"; no pricing is invented.

## 6. `unsafe-local` is never the default

`src/sandbox/select.ts` never selects `unsafe-local` through `auto`; the backend requires both
`sandbox.backend === "unsafe-local"` and `policy.allowUnsafeLocal === true`, and refuses otherwise
with `SandboxUnavailableError` (`src/sandbox/unsafeLocal.ts`). Every record it produces carries
`backendId: "unsafe-local"` so it can be rendered under an `UNSAFE LOCAL MODE` banner.

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
