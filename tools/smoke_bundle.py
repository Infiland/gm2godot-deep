"""Exercise a packaged host without a checkout, npm, or Node on PATH."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import zipfile
from pathlib import Path
from queue import Queue


def research_smoke(command: list[str], root: Path, environment: dict[str, str]) -> None:
    """Drive the actual JSONL boundary through review and fresh candidate publication."""
    source, baseline = root / "source", root / "baseline"
    source.mkdir()
    baseline.mkdir()
    (source / "demo.yyp").write_text('{"resources":[]}')
    (baseline / "project.godot").write_text("config_version=5\n")
    snapshot = root / "host.json"
    snapshot.write_text(json.dumps({
        "schemaVersion": 1, "gm2godotVersion": "1.0.0", "gmlApiEntries": [],
        "inventory": {
            "project": {"name": "demo", "yypPath": "demo.yyp", "ideVersion": "2024.1", "resourceType": "GMProject", "resourceVersion": "2.0"},
            **{name: [] for name in ("resources", "objects", "rooms", "scripts", "sprites", "shaders", "extensions", "diagnostics")},
        },
    }))
    process = subprocess.Popen(command, cwd=root, env=environment, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
    events: Queue[dict] = Queue()

    def read_events() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            events.put(json.loads(line))
        events.put({"type": "error", "error": "Host closed before completion"})

    threading.Thread(target=read_events, daemon=True).start()
    try:
        params = {"jobRoot": str(root / "job"), "sourcePath": str(source), "baselinePath": str(baseline),
                  "hostSnapshotPath": str(snapshot), "settings": {"runtime": "mock", "model": "mock", "provider": "", "freeOnly": False}}
        for method, expected in (("research", "review"), ("convert", "complete")):
            assert process.stdin is not None
            process.stdin.write(json.dumps({"protocolVersion": 1, "id": method, "method": method, "params": params}) + "\n")
            process.stdin.flush()
            while True:
                event = events.get(timeout=90)
                if event.get("type") == "error":
                    raise ValueError(f"Packaged {method} failed: {event}")
                if event.get("type") == "completed":
                    if event.get("result", {}).get("state") != expected:
                        raise ValueError(f"Unexpected packaged {method} result: {event}")
                    break
        if not (root / "baseline-deep/project.godot").is_file():
            raise ValueError("Packaged conversion did not publish a fresh candidate")
        if (baseline / "project.godot").read_text() != "config_version=5\n":
            raise ValueError("Packaged conversion modified its baseline")
    finally:
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        # Frozen research snapshots must be writable for Windows temporary cleanup.
        for path in root.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)


def smoke(directory: Path) -> None:
    archives = sorted(directory.glob("gm2godot-deep-*.zip"))
    if len(archives) != 1:
        raise ValueError("Smoke test expects one platform bundle")
    with tempfile.TemporaryDirectory(prefix="deep-clean-install-") as temporary:
        root = Path(temporary)
        with zipfile.ZipFile(archives[0]) as archive:
            archive.extractall(root)
        metadata = json.loads((root / "bundle.json").read_text())
        runtime = root / metadata["runtime"]
        runtime.chmod(0o755)
        request = {"protocolVersion": 1, "id": "smoke", "method": "capabilities", "params": {}}
        result = subprocess.run(
            [str(runtime), str(root / metadata["entrypoint"])], cwd=root,
            env={**os.environ, "PATH": str(root / "absent-tools")},
            input=json.dumps(request) + "\n", text=True, capture_output=True, timeout=60, check=True,
        )
        messages = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        response = next(row for row in messages if row.get("id") == "smoke")
        if response.get("type") != "result" or response["result"].get("requiresPython") is not False:
            raise ValueError(f"Packaged host did not respond correctly: {response}")
        if (root / "engine/src").exists():
            raise ValueError("Release should contain compiled code, not a source checkout")
        research_smoke([str(runtime), str(root / metadata["entrypoint"])], root,
                       {**os.environ, "PATH": str(root / "absent-tools")})
        print(f"Packaged host research/review/conversion passed (simulated agents): {metadata['platform']} {metadata['version']}")


if __name__ == "__main__":
    smoke(Path(sys.argv[1]))
