"""Download and verify only the pinned official Node executable and license."""
from __future__ import annotations

import hashlib
import io
import shutil
import tarfile
import urllib.request
import zipfile
from pathlib import Path

NODE_VERSION = "22.19.0"
NODE_PLATFORMS = {"win-x64": "win-x64", "darwin-arm64": "darwin-arm64", "linux-x64": "linux-x64"}


def _download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:
        if not response.url.startswith("https://nodejs.org/"):
            raise ValueError("Unexpected Node download origin")
        return response.read()


def install_node(platform: str, staging: Path, local: Path | None = None) -> str:
    relative = "node/node.exe" if platform == "win-x64" else "node/bin/node"
    destination = staging / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    if local is not None:
        shutil.copy2(local, destination)
        destination.chmod(0o755)
        # Test-only local runtimes must not be mistaken for release provenance.
        (staging / "node/LOCAL_RUNTIME.txt").write_text("Local runtime supplied for smoke testing, not redistribution.\n")
        return relative
    name = f"node-v{NODE_VERSION}-{NODE_PLATFORMS[platform]}"
    suffix = ".zip" if platform == "win-x64" else ".tar.gz"
    base = f"https://nodejs.org/dist/v{NODE_VERSION}"
    checksums = _download(f"{base}/SHASUMS256.txt").decode("ascii")
    expected = next((line.split()[0] for line in checksums.splitlines() if line.split()[-1] == name + suffix), None)
    if expected is None:
        raise ValueError("Node checksum missing")
    data = _download(f"{base}/{name}{suffix}")
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Node checksum mismatch")
    members = [(f"{name}/node.exe" if platform == "win-x64" else f"{name}/bin/node", destination),
               (f"{name}/LICENSE", staging / "node/LICENSE")]
    if platform == "win-x64":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member, target in members:
                target.write_bytes(archive.read(member))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member, target in members:
                info = archive.getmember(member)
                if not info.isfile():
                    raise ValueError("Node package member is not a file")
                stream = archive.extractfile(info)
                if stream is None:
                    raise ValueError("Node package member unavailable")
                with stream:
                    target.write_bytes(stream.read())
    destination.chmod(0o755)
    return relative
