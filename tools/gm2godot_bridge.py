#!/usr/bin/env python3
"""Read-only JSON bridge into a pinned GM2Godot checkout.

This is the only place in ``gm2godot-deep`` that imports upstream Python
internals.  It never writes into the GameMaker project and never writes Godot
output; ``GameMakerResourceIndex`` is given a throwaway temporary directory as
its ``godot_project_path`` (and that directory is removed afterwards) because
its constructor requires one even though ``build()`` writes no Godot files.

Contract
--------
* stdout carries exactly one JSON document and nothing else.  ``sys.stdout`` is
  rebound to ``sys.stderr`` for the whole computation so any incidental upstream
  ``print`` cannot corrupt the payload; only the final ``json.dumps`` result is
  written to the real stdout.
* every diagnostic/log line goes to stderr.
* exit 0 on success, 2 on usage error, 1 on any other failure, and 3 when the
  pinned API does not match the shape this bridge expects (``ImportError``,
  ``AttributeError`` or an unexpected ``TypeError`` while importing or calling
  it) — in that case stdout is ``{"error":"BRIDGE_API_MISMATCH","detail":...}``.
  A mismatch is never degraded into a partial result.

Access paths for data that has no typed model attribute
-------------------------------------------------------
* ``ObjectModel`` exposes only ``event_count``; the individual events live in
  ``ObjectModel.raw_data["eventList"]`` (entries with ``eventType``/``eventNum``).
  The expected source filename for each event is produced by upstream's own
  ``src.conversion.event_mapping`` helpers, exactly as ``src/conversion/objects.py``
  does it: ``map_input_event(event)`` for input event types, otherwise
  ``map_event(event)`` (both return an ``EventMapping`` whose ``gml_filename`` is
  the source filename).
* ``RoomModel`` has no instance list.  Instances live on
  ``IndexedRoom.layers`` — each layer with ``resourceType == "GMRInstanceLayer"``
  carries an ``instances`` list whose entries have ``%Name``/``name``,
  ``objectId.name``, ``x`` and ``y``.  Their execution order comes from
  ``IndexedRoom.instance_creation_order`` (entries with ``%Name``/``name``),
  mirroring ``src/conversion/room_layers.py``.
* ``IndexedExtensionFunction`` records are keyed by GML function name in
  ``GameMakerResourceIndex.get_extension_functions()``; ``extension_name`` groups
  them back into their owning extension.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

# Captured before any redirection so the payload always reaches the real stdout.
_REAL_STDOUT = sys.stdout

MISMATCH_EXIT = 3
USAGE_EXIT = 2
FAILURE_EXIT = 1


def _log(message: str) -> None:
    print(message, file=sys.stderr)


def _emit(payload: object) -> None:
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    try:
        _REAL_STDOUT.write(text + "\n")
        _REAL_STDOUT.flush()
    except BrokenPipeError:
        # A consumer such as `... | head -c 600` closed the pipe early. The
        # bridge succeeded; exit quietly instead of emitting a traceback or a
        # noisy flush error at interpreter shutdown.
        try:
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, _REAL_STDOUT.fileno())
            os.close(devnull)
        except OSError:
            pass
        raise SystemExit(0) from None


def _mismatch(exc: BaseException, command: str) -> int:
    _log(f"BRIDGE_API_MISMATCH during {command!r}: {type(exc).__name__}: {exc}")
    _emit(
        {
            "error": "BRIDGE_API_MISMATCH",
            "detail": f"{type(exc).__name__}: {exc}",
        }
    )
    return MISMATCH_EXIT


def _failure(exc: BaseException, command: str) -> int:
    _log(f"gm2godot bridge failed during {command!r}: {type(exc).__name__}: {exc}")
    _emit({"error": "BRIDGE_FAILED", "detail": f"{type(exc).__name__}: {exc}"})
    return FAILURE_EXIT


def _usage(detail: str) -> int:
    _log(f"usage error: {detail}")
    _emit({"error": "BRIDGE_USAGE", "detail": detail})
    return USAGE_EXIT


# --------------------------------------------------------------------------- #
# primitive coercion — every emitted value is str/int/float/bool/None/list/dict
# --------------------------------------------------------------------------- #


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _integer(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _number(value: object) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return None


def _boolean(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _dict_value(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _dict_list(value: object) -> list:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _normalized_name(entry: dict) -> str | None:
    return _text(entry.get("%Name")) or _text(entry.get("name"))


# --------------------------------------------------------------------------- #
# checkout import
# --------------------------------------------------------------------------- #


def _prepare_checkout(checkout: str) -> None:
    """Put the pinned checkout first on sys.path and import its modules.

    Import errors are deliberately *not* caught here: the caller maps them to
    BRIDGE_API_MISMATCH so a wrong/tampered checkout is never silently tolerated.
    """
    checkout = os.path.abspath(checkout)
    if not os.path.isdir(checkout):
        raise ImportError(f"GM2Godot checkout directory does not exist: {checkout}")
    sys.path.insert(0, checkout)


class _Upstream:
    """Holder for the pinned API entry points, imported once per process."""

    def __init__(self) -> None:
        from src.conversion.event_mapping import is_input_event, map_event, map_input_event
        from src.conversion.gml_transpiler_parts.gml_api_manifest import iter_gml_api_entries
        from src.conversion.project_manifest import load_gamemaker_project_manifest
        from src.conversion.resource_index import GameMakerResourceIndex
        from src.conversion.resource_models import parse_gamemaker_resource_models
        from src.version import get_version

        self.load_gamemaker_project_manifest = load_gamemaker_project_manifest
        self.GameMakerResourceIndex = GameMakerResourceIndex
        self.parse_gamemaker_resource_models = parse_gamemaker_resource_models
        self.iter_gml_api_entries = iter_gml_api_entries
        self.map_event = map_event
        self.map_input_event = map_input_event
        self.is_input_event = is_input_event
        self.get_version = get_version


# --------------------------------------------------------------------------- #
# probe
# --------------------------------------------------------------------------- #


def _git_commit(checkout: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", checkout, "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    commit = result.stdout.strip()
    return commit or None


def _probe(upstream: _Upstream, checkout: str) -> dict:
    return {
        "gm2godotVersion": upstream.get_version(),
        "pythonVersion": "%d.%d.%d" % sys.version_info[:3],
        "pythonExecutable": sys.executable,
        "checkout": os.path.abspath(checkout),
        "commit": _git_commit(checkout),
    }


# --------------------------------------------------------------------------- #
# inventory
# --------------------------------------------------------------------------- #


def _event_file(upstream: _Upstream, event: dict) -> str | None:
    if event.get("isDnD") is True:
        # Upstream (src/conversion/objects.py) skips drag-and-drop events;
        # there is no GML source file to point at.
        return None
    mapping = (
        upstream.map_input_event(event)
        if upstream.is_input_event(event)
        else upstream.map_event(event)
    )
    if mapping is None:
        return None
    return _text(mapping.gml_filename)


def _object_events(upstream: _Upstream, raw_data: dict) -> list[dict]:
    events: list[dict] = []
    for event in _dict_list(raw_data.get("eventList")):
        events.append(
            {
                "eventType": _integer(event.get("eventType")),
                "eventNum": _integer(event.get("eventNum")),
                "file": _event_file(upstream, event),
            }
        )
    return events


def _creation_order(room) -> dict[str, int]:
    order: dict[str, int] = {}
    for index, entry in enumerate(room.instance_creation_order):
        if not isinstance(entry, dict):
            continue
        name = _normalized_name(entry)
        if name and name not in order:
            order[name] = index
    return order


def _room_instances(room) -> list[dict]:
    """Instances from GMRInstanceLayer layers, ordered by creation order."""
    creation_order = _creation_order(room)
    collected: list[tuple[int, int, dict]] = []
    sequence = 0
    for layer in room.layers:
        if not isinstance(layer, dict) or layer.get("resourceType") != "GMRInstanceLayer":
            continue
        for instance in _dict_list(layer.get("instances")):
            name = _normalized_name(instance)
            order_index = creation_order.get(name) if name else None
            sort_order = (
                order_index
                if order_index is not None
                else len(creation_order) + sequence
            )
            collected.append((sort_order, sequence, instance))
            sequence += 1
    collected.sort(key=lambda item: (item[0], item[1]))
    instances: list[dict] = []
    for _sort_order, _sequence, instance in collected:
        object_id = _dict_value(instance.get("objectId"))
        instances.append(
            {
                "name": _normalized_name(instance),
                "objectName": _text(object_id.get("name")),
                "x": _number(instance.get("x")),
                "y": _number(instance.get("y")),
            }
        )
    return instances


def _room_layers(room) -> list[dict]:
    layers: list[dict] = []
    for order, layer in enumerate(room.layers):
        if not isinstance(layer, dict):
            continue
        layers.append(
            {
                "name": _normalized_name(layer),
                "resourceType": _text(layer.get("resourceType")),
                "depth": _integer(layer.get("depth")),
                "order": order,
            }
        )
    return layers


def _room_model_by_name(models) -> dict:
    return {model.name: model for model in models.rooms}


def _room_entry(room, model, ordered_room_names: set[str]) -> dict:
    settings = _dict_value(room.room_settings)
    width = _integer(settings.get("Width"))
    if width is None:
        width = _integer(settings.get("width"))
    height = _integer(settings.get("Height"))
    if height is None:
        height = _integer(settings.get("height"))
    persistent = _boolean(settings.get("persistent"))
    if persistent is None and model is not None:
        persistent = model.persistent
    parent_room = _dict_value(room.parent_room)
    parent_room_name = _text(parent_room.get("name")) or _text(parent_room.get("path"))
    if parent_room_name and parent_room_name.endswith(".yy"):
        parent_room_name = os.path.splitext(os.path.basename(parent_room_name))[0]
    if not parent_room_name and model is not None:
        parent_room_name = model.parent_room_name
    return {
        "name": room.name,
        "width": width,
        "height": height,
        "persistent": persistent if persistent is not None else False,
        "parentRoomName": parent_room_name,
        "creationCodeFile": _text(room.creation_code_file),
        "ordered": room.name in ordered_room_names,
        "layers": _room_layers(room),
        "instances": _room_instances(room),
    }


def _script_entries(models) -> list[dict]:
    return [
        {"name": model.name, "gmlPath": model.gml_path} for model in models.scripts
    ]


def _sprite_entries(models) -> list[dict]:
    entries: list[dict] = []
    for model in models.sprites:
        frames = model.raw_data.get("frames")
        frame_count = len(frames) if isinstance(frames, list) else None
        entries.append(
            {
                "name": model.name,
                "width": model.width,
                "height": model.height,
                "frameCount": frame_count,
            }
        )
    return entries


def _shader_entries(models) -> list[dict]:
    return [
        {
            "name": model.name,
            "vertexPath": model.vertex_path,
            "fragmentPath": model.fragment_path,
        }
        for model in models.shaders
    ]


def _extension_entries(extension_functions: dict) -> list[dict]:
    grouped: dict[str, list[dict]] = {}
    for function_name in sorted(extension_functions):
        function = extension_functions[function_name]
        grouped.setdefault(function.extension_name, []).append(
            {"name": function.function_name, "argCount": function.arg_count}
        )
    return [
        {"name": name, "functions": sorted(functions, key=lambda item: item["name"])}
        for name, functions in sorted(grouped.items())
    ]


def _diagnostic_entries(manifest, models) -> list[dict]:
    entries: list[dict] = []
    seen: set[tuple] = set()

    def add(entry: dict) -> None:
        key = (
            entry["severity"],
            entry["code"],
            entry["message"],
            entry["sourcePath"],
            entry["line"],
            entry["resource"],
            entry["resourceKind"],
        )
        if key in seen:
            return
        seen.add(key)
        entries.append(entry)

    for diagnostic in manifest.diagnostics:
        source = diagnostic.source
        add(
            {
                "severity": diagnostic.severity,
                "code": diagnostic.code,
                "message": diagnostic.message,
                "sourcePath": source.path if source is not None else None,
                "line": source.line if source is not None else None,
                "resource": diagnostic.resource,
                "resourceKind": diagnostic.resource_kind,
            }
        )
    for diagnostic in models.diagnostics:
        add(
            {
                "severity": diagnostic.severity,
                "code": diagnostic.code,
                "message": diagnostic.message,
                "sourcePath": _text(diagnostic.source_path),
                "line": None,
                "resource": _text(diagnostic.resource_name),
                "resourceKind": _text(diagnostic.resource_kind),
            }
        )
    return entries


def _object_event_paths(upstream: _Upstream, model) -> list[str]:
    """Existing event source files for an object, resolved beside its ``.yy``.

    Event filenames come from upstream's own ``EventMapping`` (see the module
    docstring); a filename whose source file does not exist is skipped rather
    than emitted as a phantom path.
    """
    directory = os.path.dirname(model.yy_path)
    paths: list[str] = []
    for event in _dict_list(model.raw_data.get("eventList")):
        filename = _event_file(upstream, event)
        if not filename:
            continue
        candidate = os.path.join(directory, filename)
        if os.path.isfile(candidate) and candidate not in paths:
            paths.append(candidate)
    return paths


def _resource_entries(
    upstream: _Upstream, index, manifest, models
) -> list[dict]:
    model_by_kind = {
        "objects": {model.name: model for model in models.objects},
        "rooms": _room_model_by_name(models),
        "scripts": {model.name: model for model in models.scripts},
        "shaders": {model.name: model for model in models.shaders},
        "sprites": {model.name: model for model in models.sprites},
    }
    entries: list[dict] = []
    for reference in manifest.resources:
        source_paths: list[str] = []
        model = model_by_kind.get(reference.kind, {}).get(reference.name)
        yy_path = index.resolve_gm_path(reference.kind, reference.name)
        if not yy_path and model is not None:
            yy_path = _text(model.yy_path)
        if yy_path and os.path.isfile(yy_path):
            source_paths.append(yy_path)
        candidates: list[str] = []
        if reference.kind == "scripts" and model is not None and model.gml_path:
            candidates.append(model.gml_path)
        elif reference.kind == "shaders" and model is not None:
            candidates.extend(
                path for path in (model.vertex_path, model.fragment_path) if path
            )
        elif reference.kind == "objects" and model is not None:
            candidates.extend(_object_event_paths(upstream, model))
        for candidate in candidates:
            if candidate and os.path.isfile(candidate) and candidate not in source_paths:
                source_paths.append(candidate)
        indexed = index.get_resource(reference.kind, reference.name)
        entries.append(
            {
                "name": reference.name,
                "kind": reference.kind,
                "typeName": _text(reference.resource_type),
                "yypPath": _text(reference.path),
                "sourcePaths": source_paths,
                "godotPath": _text(indexed.godot_path) if indexed is not None else None,
            }
        )
    return entries


def _build_inventory(upstream: _Upstream, gm_project: str) -> dict:
    manifest = upstream.load_gamemaker_project_manifest(gm_project)
    temp_dir = tempfile.mkdtemp(prefix="gm2godot-bridge-")
    try:
        index = upstream.GameMakerResourceIndex(
            gm_project,
            temp_dir,
            log_callback=lambda message: print(message, file=sys.stderr),
        )
        index.build()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
    models = upstream.parse_gamemaker_resource_models(gm_project)

    ordered_room_names = (
        set()
        if getattr(index, "used_room_order_fallback", True)
        else set(index.room_order)
    )
    rooms = index.ordered_rooms()
    if not rooms and index.rooms:
        rooms = [index.rooms[name] for name in sorted(index.rooms)]
    room_models = _room_model_by_name(models)

    return {
        "project": {
            "name": manifest.project_name,
            "yypPath": manifest.yyp_path,
            "ideVersion": manifest.ide_version,
            "resourceType": manifest.resource_type,
            "resourceVersion": manifest.resource_version,
        },
        "resources": _resource_entries(upstream, index, manifest, models),
        "objects": [
            {
                "name": model.name,
                "parentObjectName": model.parent_object_name,
                "persistent": model.persistent,
                "solid": model.solid,
                "spriteName": model.sprite_name,
                "events": _object_events(upstream, model.raw_data),
            }
            for model in models.objects
        ],
        "rooms": [
            _room_entry(room, room_models.get(room.name), ordered_room_names)
            for room in rooms
        ],
        "scripts": _script_entries(models),
        "sprites": _sprite_entries(models),
        "shaders": _shader_entries(models),
        "extensions": _extension_entries(index.get_extension_functions()),
        "diagnostics": _diagnostic_entries(manifest, models),
    }


# --------------------------------------------------------------------------- #
# gml-api
# --------------------------------------------------------------------------- #


def _gml_api(upstream: _Upstream) -> dict:
    entries = [
        {
            "name": entry.name,
            "category": entry.category,
            "status": entry.status,
            "issueNumber": entry.issue_number,
            "ownerModule": entry.owner_module,
            "parserSupport": entry.parser_support,
            "emitterSupport": entry.emitter_support,
            "runtimeSupport": entry.runtime_support,
            "smokeCoverage": entry.smoke_coverage,
            "docsUrl": entry.docs_url,
            "notes": entry.notes,
        }
        for entry in upstream.iter_gml_api_entries()
    ]
    return {"entries": entries}


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="gm2godot_bridge.py",
        description="Read-only JSON bridge into a pinned GM2Godot checkout.",
    )
    parser.add_argument(
        "--checkout",
        action="append",
        required=True,
        metavar="DIR",
        help="path to the pinned GM2Godot checkout (repeatable; the last wins)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("probe", help="report checkout/python versions")
    inventory = subparsers.add_parser("inventory", help="index a GameMaker project")
    inventory.add_argument("--gm-project", required=True, metavar="DIR")
    subparsers.add_parser("gml-api", help="dump the upstream GML API manifest")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(sys.argv[1:] if argv is None else argv))
    checkout = os.path.abspath(args.checkout[-1])
    command = args.command

    # stdout purity: everything the upstream API might print goes to stderr.
    sys.stdout = sys.stderr
    try:
        _prepare_checkout(checkout)
        try:
            upstream = _Upstream()
        except (ImportError, AttributeError, TypeError) as exc:
            return _mismatch(exc, command)
        if command == "probe":
            payload = _probe(upstream, checkout)
        elif command == "inventory":
            payload = _build_inventory(upstream, args.gm_project)
        elif command == "gml-api":
            payload = _gml_api(upstream)
        else:  # pragma: no cover - argparse enforces the set
            return _usage(f"unknown command: {command}")
    except (ImportError, AttributeError, TypeError) as exc:
        return _mismatch(exc, command)
    except Exception as exc:  # noqa: BLE001 - bridge boundary: report, never crash
        return _failure(exc, command)
    finally:
        sys.stdout = _REAL_STDOUT

    try:
        _emit(payload)
    except Exception as exc:  # noqa: BLE001 - serialization boundary
        return _failure(exc, command)
    return 0


if __name__ == "__main__":
    sys.exit(main())
