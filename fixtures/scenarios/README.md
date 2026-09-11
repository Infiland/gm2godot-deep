# Counter trace scenario

Level D behavioural fixture for the synthetic `counter` GameMaker project. It steps a GM2Godot
port of `fixtures/gm-projects/counter` under headless Godot and prints one machine-readable
observation line, which `fixtures/traces/counter_expected.json` records as a synthetic
expectation.

| File | Role |
| --- | --- |
| `fixtures/scenarios/counter_trace.gd` | The `extends SceneTree` scenario harness. Copied to `tools/deep_trace.gd` inside a candidate project by `src/validation/behavioral.ts` (`BEHAVIORAL_SCENARIO_RELATIVE_PATH`). |
| `fixtures/traces/counter_expected.json` | The recorded expectation (`schemaVersion: 1`, `provenance: "synthetic"`), parsed by `parseTrace` / `TraceFileSchema`. |

## The observation line

The harness prints exactly one line:

```
DEEP_TRACE [ {"step":…, "kind":…, "target":…, "payload":{…}}, … ]
```

The JSON after the prefix is the **event array itself**, not a full trace document: the consumer
`src/validation/trace.ts: observeTrace` parses it as `TraceFileSchema.shape.events`. The full
document (`schemaVersion`, `name`, `provenance`, `randomness`, `timing`, `events`) is what
`counter_expected.json` stores.

`behavioral.ts` copies the project to a fresh validation directory, installs the scenario at
`tools/deep_trace.gd` and runs exactly:

```
<godot> --headless --path <projectCopy> --script res://tools/deep_trace.gd
```

## Running it by hand

```
GD=/Applications/Godot.app/Contents/MacOS/Godot
PY=/Users/infi/Documents/Github/.gm2godot-campaign-venv/bin/python
GM2GODOT=/Users/infi/Documents/Github/GM2Godot
REPO=/Users/infi/Documents/Github/gm2godot-deep

# 1. Convert the fixture (the --gm-project path MUST be absolute; a relative one silently
#    finds no options/ directory).
$PY $GM2GODOT/main.py convert \
  --gm-project $REPO/fixtures/gm-projects/counter \
  --godot-project /private/tmp/counter-trace-godot \
  --target-platform macos --groups assets,project,wip --allow-partial \
  --report-dir /private/tmp/counter-trace-reports

# 2. Scratch copy + scenario install.
rm -rf /private/tmp/counter-trace-run
cp -R /private/tmp/counter-trace-godot /private/tmp/counter-trace-run
mkdir -p /private/tmp/counter-trace-run/tools
cp $REPO/fixtures/scenarios/counter_trace.gd /private/tmp/counter-trace-run/tools/deep_trace.gd

# 3. Import the generated resources once. GM2Godot's output has no .godot/import cache, so a
#    cold project has no Texture2D loader for sprites/spr_counter/spr_counter.png.
$GD --headless --path /private/tmp/counter-trace-run --import      # exit 0

# 4. Run the scenario.
$GD --headless --path /private/tmp/counter-trace-run --script res://tools/deep_trace.gd
```

`--import` only adds Godot's own `.godot/` cache, `.import` and `.gd.uid` files; it leaves
`project.godot` and every generated `.gd`/`.tscn` byte-identical.

## Observed output

Command 1 (`convert`) exit status `0`; last stdout line:

```
GM2Godot conversion outcome: partial; converters[requested=15, executed=15, completed=15, skipped=0, failed=0]; resources[requested=16, executed=16, completed=15, skipped=1, failed=0]
```

Command 3 (`--import`) exit status `0`. Command 4 exit status `0`, stdout:

```
Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org

DEEP_TRACE [{"kind":"step","payload":{"counter_step":1,"global.counter":1,"instance_position":"noone"},"step":0,"target":"obj_counter"},{"kind":"step","payload":{"counter_step":2,"global.counter":2,"instance_position":"noone"},"step":1,"target":"obj_counter"},{"kind":"step","payload":{"counter_step":3,"global.counter":3,"instance_position":"noone"},"step":2,"target":"obj_counter"},{"kind":"step","payload":{"counter_step":4,"global.counter":4,"instance_position":"noone"},"step":3,"target":"obj_counter"},{"kind":"step","payload":{"counter_step":5,"global.counter":5,"instance_position":"noone"},"step":4,"target":"obj_counter"},{"kind":"step","payload":{"counter_step":6,"global.counter":6,"instance_position":"noone"},"step":5,"target":"obj_counter"}]
```

stderr is empty; no `ERROR`/`SCRIPT ERROR` line is emitted.

Without the `--import` step the same trace is still printed with exit status `0`, but the engine
also reports the two cold-cache errors below, which `runGodotHeadless`'s `firstEngineErrorLine`
treats as a failed run — so a candidate must have been imported (for example by the level B
`gm2godot validate` pass) before level D:

```
ERROR: No loader found for resource: res://sprites/spr_counter/spr_counter.png (expected type: Texture2D)
ERROR: res://sprites/spr_counter/spr_counter.tscn:21 - Parse Error: [ext_resource] referenced non-existent resource at: res://sprites/spr_counter/spr_counter.png.
```

## Determinism

Two consecutive runs of the same command produce identical stdout byte-for-byte (the
`DEEP_TRACE` line hashes to
`4f064233ac591f3a7eaa1da29c764a3b2db545728a9dea4d0f05fc089f6989d1` both times). The scenario
calls `seed(12345)` and steps a fixed count, so nothing depends on frame timing.

## What each event means

Every step produces exactly one event; `timing.steps` is `6`.

| Field | Meaning |
| --- | --- |
| `step` | `0`-based index of the completed `_on_step` call. |
| `kind` | `"step"` — the generated `objects/obj_counter/obj_counter.gd: _on_step()` entry point ran once. |
| `target` | `"obj_counter"` — the converted unit under observation. |
| `payload.counter_step` | The instance-local `counter_step` after the step. The Create event sets it to `0`; the Step event replaces it with `scr_math_add(counter_step, 1)`, so it reads `1…6`. |
| `payload["global.counter"]` | `gml_selector_get(gml_global_scope(), "counter")` after the step. The room creation code that initialises it to `0` does not run in this scenario, so the value is `1…6` (it is GML-undefined before the first step). |
| `payload.instance_position` | The observed result of `GMRuntime.gml_instance_position(instance, 0, 0, <obj_counter_child>)`. It is `"noone"` because only `obj_counter` is instantiated. This is the GML API the pinned GM2Godot manifest reports as `partial` (upstream issue `#487`), so the hazard stays visible in the trace. |

The scenario does not exercise `obj_counter_child`, room transitions, `scr_state` or randomness;
the fixture covers those in the analysis fixtures instead.

## Provenance

`counter_expected.json` has `provenance: "synthetic"`. It is **not** an observation of the
original GameMaker runtime — there is no GameMaker runner on this machine. It was produced by
stepping the GM2Godot-generated baseline of the synthetic fixture, exactly as the file's
`randomness.note` states. `behavioral.ts` renders the provenance verbatim in the level D check
name, so a synthetic expectation can never be read as original-game behaviour.

## Verifying the expectation parses and matches

```
cd /Users/infi/Documents/Github/gm2godot-deep
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { TraceFileSchema } from "./src/evidence/schemas.ts";
import { observeTrace, parseTrace, compareTraces, describeDifferences } from "./src/validation/trace.ts";
const raw = JSON.parse(readFileSync("fixtures/traces/counter_expected.json", "utf8"));
const schema = TraceFileSchema.safeParse(raw);
console.log("TraceFileSchema.safeParse:", schema.success, schema.success ? "(no issues)" : JSON.stringify(schema.error.issues));
const expected = parseTrace(raw);
const observed = observeTrace(readFileSync("/private/tmp/counter-trace-run.out", "utf8"));
const compared = compareTraces(expected.events, observed);
console.log("compareTraces equal:", compared.equal, "|", describeDifferences(compared.differences));
'
```

Observed result:

```
TraceFileSchema.safeParse: true (no issues)
compareTraces equal: true | no differences
```

## Why the work happens on the first `_process` frame

A `--script` `SceneTree` script gets `_initialize()` from `MainLoop` before the root window is
inside the tree. A node added to `root` there reports `is_inside_tree() == false`, never receives
`_ready`, and therefore never registers with the GML runtime (`id` stays invalid and
`counter_step` stays GML-undefined, which makes `gml_add` fail). The harness therefore performs
all work on the first `_process` frame, where `root.add_child(instance)` runs `_ready`
synchronously, then prints the trace and returns `true` to quit.
