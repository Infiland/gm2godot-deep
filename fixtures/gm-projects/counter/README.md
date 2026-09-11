# `fixtures/gm-projects/counter` — synthetic GameMaker LTS 2026 project

This is the smallest GameMaker project that exercises every structural feature the
`gm2godot-deep` pipeline needs from a real input: object inheritance, script-to-script
cycles, a shared global, a room-owned global write, a room creation-code file, and one
GML API whose upstream support status is below `implemented`.

It is **synthetic**, authored here from the verified IDE-2026 `.yy` shapes (see
[Provenance](#provenance)). It is not a capture of any real game.

## File inventory

| File | Contents | Fixture property carried |
|---|---|---|
| `Counter.yyp` | Project manifest: `resources[]` for the six resources, `RoomOrderNodes: [rm_main]`, `Folders[]`, `TextureGroups[]`, `AudioGroups[]`, `MetaData.IDEVersion: "2026.0.0.16"`. | — (declares all resources) |
| `options/main/options_main.yy` | Minimal `GMMainOptions` (`option_game_speed: 60`), the input the `project` converter group reads for `project_settings`; it drives `application/run/max_fps` in the generated `project.godot`. | — |
| `scripts/scr_math/scr_math.yy` | `GMScript` metadata; `parent` folder `folders/Scripts.yy`. | — |
| `scripts/scr_math/scr_math.gml` | `function scr_math_add(_a, _b)` returning `_a + _b` (the script the plan names) and `function scr_math_scale(_value)`, which **reads** `global.counter` via `max(global.counter, 1)`. | **3** (second half of the cycle: it touches `global.counter` but contains no reference to `scr_state`) |
| `scripts/scr_state/scr_state.yy` | `GMScript` metadata; same parent folder as `scr_math`. | — |
| `scripts/scr_state/scr_state.gml` | `scr_state_reset()` (writes `global.counter = 0`, `global.handler = -1`), `scr_state_advance(_n)` (writes `global.counter` through **a call to `scr_math_add`**), `scr_state_dispatch(_n)` containing `script_execute(global.handler, _n)` and `asset_get_index("spr_" + string(_n))`. | **3** (calls `scr_math_add`), **4** (both unresolved dynamic references) |
| `objects/obj_counter/obj_counter.yy` | `GMObject` with events `(eventType 0, eventNum 0)` → `Create_0.gml` and `(eventType 3, eventNum 0)` → `Step_0.gml`; `spriteId → spr_counter`; `parentObjectId: null`. | — |
| `objects/obj_counter/Create_0.gml` | `counter_step = 0;` | — |
| `objects/obj_counter/Step_0.gml` | `counter_step = scr_math_add(counter_step, 1); global.counter = counter_step;` then `instance_position(x, y, obj_counter_child)`. | **2** (`scr_math_add` call + `global.counter` write), **5** (the partial-status API call) |
| `objects/obj_counter_child/obj_counter_child.yy` | `GMObject` whose `parentObjectId` is `{"name":"obj_counter","path":"objects/obj_counter/obj_counter.yy"}`. | **1** (inheritance) |
| `objects/obj_counter_child/Create_0.gml` | `child_bonus = scr_math_add(1, 1);` — child-only work; the parent's Create event is inherited through `parentObjectId`. | **1** (a child behaviour distinct from the parent) |
| `rooms/rm_main/rm_main.yy` | `GMRoom` with an `Instances` layer holding one `GMRInstance` of `obj_counter` (`inst_counter_1`), a `Background` layer, `instanceCreationOrder`, and `creationCodeFile: "${project_dir}/rooms/rm_main/RoomCreationCode.gml"`. | — (room instance → `instance_creation` edge) |
| `rooms/rm_main/RoomCreationCode.gml` | `global.counter = 0;` | **6** (room-owned `global.counter` write) |
| `sprites/spr_counter/spr_counter.yy` | `GMSprite` 2×2, `collisionKind: 1`, one frame GUID and one image-layer GUID (below). | — |
| `sprites/spr_counter/8f0a1c6e-3d2b-4f57-9a41-2c7b5e9d0a13.png` | 2×2 RGBA composite frame image (solid `(220, 80, 80, 255)`). | — |
| `sprites/spr_counter/layers/8f0a1c6e-3d2b-4f57-9a41-2c7b5e9d0a13/b3d9e2a7-5c14-4e88-a6f0-71d4c2b8e5f9.png` | 2×2 RGBA image layer (black/white checker). This is the file GM2Godot converts. | — |
| `fixtures/tools/make-fixture-assets.mjs` | Deterministic 2×2 RGBA PNG encoder (built-in `node:zlib` deflate + a fixed CRC-32 table); writes both PNGs above. | — |

Sprite GUIDs referenced by `spr_counter.yy` (`frames[].name` / `layers[].name`):

* frame `8f0a1c6e-3d2b-4f57-9a41-2c7b5e9d0a13`
* layer `b3d9e2a7-5c14-4e88-a6f0-71d4c2b8e5f9`

## The six deliberate properties

| # | Property | Where it lives | How it is observed |
|---|---|---|---|
| 1 | `obj_counter_child` inherits `obj_counter` | `objects/obj_counter_child/obj_counter_child.yy` → `parentObjectId` | `parse_gamemaker_resource_models(...)`: `obj_counter_child.parent_object_name == "obj_counter"` |
| 2 | `Step_0.gml` calls `scr_math_add` and writes `global.counter` | `objects/obj_counter/Step_0.gml` lines 5–6 | Generated `objects/obj_counter/obj_counter.gd` calls `GMRuntime.gml_script_call(... "scr_math_add" ...)` and `GMRuntime.gml_selector_set(... "counter" ...)` |
| 3 | `scr_state.gml` calls `scr_math_add`; `scr_math.gml` is unchanged by it; the two units form the cycle `scr_math` ↔ `scr_state` | `scripts/scr_state/scr_state.gml` (`scr_state_advance`) and `scripts/scr_math/scr_math.gml` (`scr_math_scale` reading `global.counter`) | `scr_state → scr_math` is a confirmed `calls` edge; `scr_math` has **no** reference to `scr_state`. The reverse direction is the confirmed `shared_state` edge on `global.counter`, because both units touch that global: shared-state edges are grouped by global name and recorded between every pair of units touching it. |
| 4 | `scr_state.gml` contains `script_execute(global.handler, _n)` and `asset_get_index("spr_" + string(_n))` | `scripts/scr_state/scr_state.gml` (`scr_state_dispatch`) | Both identifiers are present verbatim; the scan records both as `unresolved` with evidence lines, and GM2Godot emits `GMRuntime.gml_script_execute(...)` / `GMRuntime.gml_asset_get_index(GMRuntime.gml_add("spr_", ...))` |
| 5 | `Step_0.gml` calls one real GML API whose upstream status is below `implemented` | `objects/obj_counter/Step_0.gml` line 8 | `instance_position` — status **`partial`**, upstream issue **#487**, category *Movement and Collisions* |
| 6 | `RoomCreationCode.gml` sets `global.counter = 0` | `rooms/rm_main/RoomCreationCode.gml` | Generated `rooms/rm_main/rm_main.gd` line 7: `GMRuntime.gml_selector_set(GMRuntime.gml_global_scope(), "counter", 0)` |

### Property 5 — the resolved GML API

The function was chosen by querying the pinned checkout, not from memory:

```
$ PYTHONDONTWRITEBYTECODE=1 /Users/infi/Documents/Github/.gm2godot-campaign-venv/bin/python -c \
  "import sys; sys.path.insert(0,'/Users/infi/Documents/Github/GM2Godot'); \
   from src.conversion.gml_transpiler_parts.gml_api_manifest import get_gml_api_entry as g; \
   e=g('instance_position'); print(e.status, e.name, e.issue_number, e.category, e.notes)"
partial instance_position 487 Movement and Collisions Returns matching registered instance handles using both instances' active imported masks.
```

* **Name**: `instance_position`
* **Status**: `partial`
* **Upstream issue**: `#487`
* **Category**: `Movement and Collisions`
* **Why this one**: it is gameplay logic (a collision/position query on the current
  instance), it has a `GMLFunctionDescriptor` (arity 3), so the converter transpiles it
  rather than raising a `GMLTranspileError`, and the call has a genuine non-`implemented`
  upstream status for the analysis layer to turn into an `upstream_unsupported_api`
  hazard.

`script_execute` (#512) and `asset_get_index` (#484) are both `implemented`, so their
appearance in `scr_state.gml` only exercises the *unresolved dynamic reference* path,
not the partial-API path.

## Provenance

* `.yy` / `.yyp` key shapes were read from the pinned checkout before authoring:
  * minimal `.yyp` reference: `GM2Godot/tests/fixtures/golden/basic_scripts/BasicScripts.yyp`
  * IDE-2026 object/room/options shapes:
    `/Users/infi/Documents/Github/.gm2godot-campaign-evidence/fixtures/Adding-1bf032618be258242f78505de7cd151242452776/`
    (`Adding.yyp`, `objects/obj_adding_demo/obj_adding_demo.yy`,
    `rooms/rm_adding_demo/rm_adding_demo.yy`, `options/main/options_main.yy`), `MetaData.IDEVersion` `2026.0.0.16`
  * sprite frame/layer shape and the `layers/<frame_guid>/<layer_guid>.png` layout:
    `GM2Godot/tests/test_resource_matrix_godot.py` and `GM2Godot/tests/test_sprites.py`
* The files are strict JSON (no trailing commas). GameMaker itself writes trailing
  commas and GM2Godot strips them (`src/conversion/path_registry.py:192`,
  `src/conversion/base_converter.py:364`), so both forms load; strict JSON keeps the
  fixture diffable with ordinary tooling.
* Only `.yyp` fields listed in `_KNOWN_PROJECT_FIELDS`
  (`src/conversion/project_manifest.py:45`) are emitted, so the fixture produces **no**
  `GM2GD-PROJECT-UNKNOWN-FIELD` warnings.

## Verification

All commands run from the repository root `/Users/infi/Documents/Github/gm2godot-deep`.

### 1. Asset determinism

```
$ node fixtures/tools/make-fixture-assets.mjs
7618d5efaeda979f7f27dc18f69b7e8b97e804033261c4b24780c7610e76c189  74B  fixtures/gm-projects/counter/sprites/spr_counter/8f0a1c6e-3d2b-4f57-9a41-2c7b5e9d0a13.png
b080130217233a639e6ac3e446836266d2c93f4185d6c64c8a3dfa03abf2e1ee  79B  fixtures/gm-projects/counter/sprites/spr_counter/layers/8f0a1c6e-3d2b-4f57-9a41-2c7b5e9d0a13/b3d9e2a7-5c14-4e88-a6f0-71d4c2b8e5f9.png
```

Running it a second time produces byte-identical output (same two sha256 sums above);
`sha256sum` of both files before and after the second run is identical.

### 2. Conversion with the pinned GM2Godot

`--gm-project` must be an **absolute** path. GM2Godot 0.7.74 silently discovers zero
`options/` entries when the project path is relative (`load_gamemaker_project_manifest`
returns 0 options for `fixtures/gm-projects/counter` and 21 for the same directory given
absolutely), which makes the `project_settings` step report
"No GameMaker main or target-platform options metadata was found." and contributes an
extra skipped resource. The `/private/tmp` report path is also required — see
[Deviations](#deviations).

```
$ PYTHONDONTWRITEBYTECODE=1 /Users/infi/Documents/Github/.gm2godot-campaign-venv/bin/python \
    /Users/infi/Documents/Github/GM2Godot/main.py convert \
    --gm-project /Users/infi/Documents/Github/gm2godot-deep/fixtures/gm-projects/counter \
    --godot-project /private/tmp/counter-godot \
    --target-platform macos --groups assets,project,wip \
    --allow-partial --report-dir /private/tmp/counter-reports
Converting game icon...
Icon directory not found: .../fixtures/gm-projects/counter/options/macos/icons
Updating project name...
Updated project name to: Counter
Updating project settings...
Updated project.godot with GameMaker settings
...
GM2Godot conversion outcome: partial; converters[requested=15, executed=15, completed=15, skipped=0, failed=0]; resources[requested=16, executed=16, completed=15, skipped=1, failed=0]
$ echo $?
0
```

stderr is empty (0 bytes). Observed artifacts:

```
gm2godot/conversion_manifest.json  format_version = 2
gm2godot/conversion_attempt.json   format_version = 1
conversion_attempt.json attempt.state = partial
conversion_attempt.json canonical_manifest =
  {"current_output": "verified", "path": "gm2godot/conversion_manifest.json",
   "sha256": "sha256:137741fb587215a409d3cfc2a22239413a9b3a187a48527e03dff7df63cc27a2",
   "status": "updated", "updated": true}
sha256 of conversion_manifest.json == canonical_manifest.sha256 : True
gm2godot/conversion_diagnostics.json summary = {"error": 0, "info": 1, "total": 1, "warning": 0}
project.godot: run/max_fps=60   (from options/main/options_main.yy)
```

`state: partial` is expected and correct: it is a **fresh** generation
(`status: updated`, `updated: true`, `current_output: verified`, attempt state
`partial`) with **zero** error and warning diagnostics, and `--allow-partial` maps it to
exit 0. The single `info` diagnostic is `GM2GD-CLI-TARGET-PLATFORM`
("Target platform filter: macos"). The one skipped resource is `game_icon`: the fixture
ships no `options/macos/icons/` artwork, so the icon step reports
"Icon directory not found" and skips. That skip is not an error, and sprites, scripts,
objects, the room and the room creation code all converted.

The converted sprite `sprites/spr_counter/spr_counter.png` is pixel-identical to the
authored layer PNG (2×2 RGBA, `Image.tobytes()` equality); only the PNG container bytes
differ because GM2Godot re-encodes through Pillow (79 bytes → 79 bytes).

### 3. Godot can import the converted project (extra check, not required by the plan)

```
$ /Applications/Godot.app/Contents/MacOS/Godot --headless --path /private/tmp/counter-godot --import
...
[ DONE ] reimport
$ echo $?
0
```
No script or scene parse errors were reported.

## Deviations

1. **`--report-dir /tmp/...` is refused by GM2Godot itself.** On macOS `/tmp` is a
   symlink to `/private/tmp`, and the pinned converter rejects a redirected report
   directory root:

   ```
   $ PYTHONDONTWRITEBYTECODE=1 <venv>/bin/python GM2Godot/main.py convert \
       --gm-project /Users/infi/Documents/Github/gm2godot-deep/fixtures/gm-projects/counter \
       --godot-project /tmp/counter-godot \
       --target-platform macos --groups assets,project,wip --allow-partial \
       --report-dir /tmp/counter-reports
   ...
   GM2Godot conversion outcome: failed; converters[requested=15, executed=15, completed=15, skipped=0, failed=0]; resources[requested=16, executed=16, completed=15, skipped=1, failed=0]
   GM2Godot external report generation failed: Refusing redirected or non-directory CLI static report directory root parent: /tmp
   $ echo $?
   1
   ```

   The conversion work itself succeeded (all 15 converters completed, 0 failed); only
   the report-directory safety check failed, which set the outcome to `failed`. Using
   the unredirected path `/private/tmp` — the same directory — yields exit 0 and a fresh
   attempt. This is upstream behaviour, not a property of the fixture, and GM2Godot was
   not patched.

2. **`--gm-project` must be absolute.** With a relative project path the pinned
   checkout's manifest loader discovers no `options/` entries at all:

   ```
   $ python -c "... load_gamemaker_project_manifest(p) ..."
   'fixtures/gm-projects/counter'                             -> 0 options
   '/Users/infi/Documents/Github/gm2godot-deep/fixtures/gm-projects/counter' -> 21 options
   ```

   The conversion still exits 0 in that case, but `project_settings` logs
   "No GameMaker main or target-platform options metadata was found." and the resource
   `skipped` count is 2 instead of 1, because `options/main/options_main.yy` is never
   read and `project.godot` gets no GameMaker-derived settings. All verification commands
   here therefore pass an absolute `--gm-project`.

3. **Sprite image layout.** The plan's tree sketch lists
   `sprites/spr_counter/{spr_counter.yy,<uuid>.png,layers/<uuid>.png}`. The authored
   layout keeps both PNGs but uses the real GameMaker layout for the layer image, which
   is one directory deeper:

   ```
   sprites/spr_counter/8f0a1c6e-….png                                  (composite frame)
   sprites/spr_counter/layers/8f0a1c6e-…/b3d9e2a7-….png                (image layer)
   ```

   GM2Godot only discovers sprite images under `layers/`, resolves the frame GUID from
   the parent directory name and the layer GUID from the file name
   (`src/conversion/sprites.py` `_build_ordered_frame_list`), and its own authored
   fixture writes exactly this shape
   (`tests/test_resource_matrix_godot.py`:
   `sprites/spr_checker/layers/<frame_id>/<layer_id>.png`). A flat
   `layers/<uuid>.png` would not match the frame GUID recorded in `spr_counter.yy` and
   would silently fall back to unsorted frame discovery. The composite copy at the
   sprite root is unused by the converter and exists because it is part of the real
   GameMaker sprite folder shape.

4. **`scr_math.gml` carries the cycle's second half by reading `global.counter`.**
   `scr_math.gml` deliberately contains **no** reference to `scr_state` (it is unchanged
   by `scr_state`'s call). The `scr_math → scr_state` direction of the cycle is the
   confirmed `shared_state` edge on `global.counter`, which both units touch; the
   `scr_state → scr_math` direction is the confirmed `calls` edge from
   `scr_state_advance`. Both directions are statically confirmed, so the two-unit SCC
   does not depend on any inferred or dynamic reference.
