"""Build a portable extension ZIP from compiled code and a pinned Node runtime."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from bundle_runtime import NODE_VERSION, install_node


def build_bundle(platform: str, output: Path, source_revision: str, client_revision: str,
                 release_base: str, node_runtime: Path | None = None, allow_dirty: bool = False) -> Path:
    root = Path(__file__).resolve().parents[1]
    metadata = json.loads((root / "package.json").read_text())
    if not (root / "dist/host/main.js").is_file():
        raise ValueError("Run npm run build before packaging the extension")
    if len(source_revision) != 40 or any(c not in "0123456789abcdef" for c in source_revision):
        raise ValueError("An exact Deep source commit is required")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip())
    if actual != source_revision or (dirty and not allow_dirty):
        raise ValueError("Release bundles require the exact clean source revision (use --allow-dirty only for local tests)")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="deep-bundle-") as temporary:
        staging = Path(temporary)
        engine = staging / "engine"
        engine.mkdir()
        for name in ("package.json", "package-lock.json", "THIRD_PARTY_NOTICES.md", "LICENSE"):
            shutil.copy2(root / name, engine / name)
        for name in ("dist", "schemas", "fixtures/scenarios", "fixtures/traces"):
            if (root / name).is_dir():
                shutil.copytree(root / name, engine / name)
        subprocess.run(["npm.cmd" if platform == "win-x64" else "npm", "ci", "--omit=dev", "--ignore-scripts"],
                       cwd=engine, check=True)
        shutil.rmtree(engine / "node_modules/.bin", ignore_errors=True)
        runtime = install_node(platform, staging, node_runtime)
        provenance = {
            "protocolVersion": 1, "version": metadata["version"], "nodeVersion": NODE_VERSION,
            "testBuild": bool(allow_dirty or node_runtime),
            "sourceRevision": source_revision, "clientRevision": client_revision,
            "platform": platform, "entrypoint": "engine/dist/host/main.js", "runtime": runtime,
        }
        (staging / "bundle.json").write_text(json.dumps(provenance, indent=2) + "\n")
        archive = output / f"gm2godot-deep-{metadata['version']}-{platform}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(staging.rglob("*")):
                if path.is_symlink():
                    raise ValueError(f"Unexpected package symlink: {path.relative_to(staging)}")
                if path.is_file():
                    bundle.write(path, path.relative_to(staging).as_posix())
        with archive.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        fragment = {
            **provenance, "minClientVersion": "0.8.1",
            "packages": {platform: {
                "url": f"{release_base.rstrip('/')}/{archive.name}", "sha256": digest,
                "entrypoint": provenance["entrypoint"], "runtime": runtime,
            }},
        }
        (output / f"manifest-{platform}.json").write_text(json.dumps(fragment, indent=2) + "\n")
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("win-x64", "darwin-arm64", "linux-x64"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--client-revision", required=True)
    parser.add_argument("--release-base-url", required=True)
    parser.add_argument("--node-runtime", type=Path)
    parser.add_argument("--allow-dirty", action="store_true", help="Mark a local test build, never publish")
    args = parser.parse_args()
    print(build_bundle(args.platform, args.output, args.source_revision, args.client_revision,
                       args.release_base_url, args.node_runtime, args.allow_dirty))


if __name__ == "__main__":
    main()
