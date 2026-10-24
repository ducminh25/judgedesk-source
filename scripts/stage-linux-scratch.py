#!/usr/bin/env python3
"""Stage the pinned Scratch executable without modifying its pkg payload."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path, data, mode):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def stage(archive, expected_sha256, destination):
    if len(expected_sha256) != 64 or sha256_file(archive) != expected_sha256:
        raise ValueError("Scratch archive SHA-256 does not match the pinned release")
    with zipfile.ZipFile(archive) as package:
        members = [entry for entry in package.infolist() if entry.filename == "scratch-run"]
        if len(members) != 1 or not 0 < members[0].file_size <= 128 * 1024 * 1024:
            raise ValueError("Scratch archive must contain exactly one bounded scratch-run file")
        executable = package.read(members[0])
    executable_sha256 = hashlib.sha256(executable).hexdigest()
    if destination.is_symlink():
        raise ValueError("Scratch staging directory must not be a symbolic link")
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / "scratch-run"
    if target.is_symlink() or not target.is_file() or sha256_file(target) != executable_sha256:
        atomic_write(target, executable, 0o755)
    else:
        target.chmod(0o755)
    receipt = {
        "schemaVersion": 1,
        "packageId": "scratch-linux-x64",
        "version": "0.1.7",
        "archiveSha256": expected_sha256,
        "entrypointComponentId": "scratch.runtime",
        "components": [{
            "id": "scratch.runtime", "kind": "executable", "relativePath": "scratch-run",
            "roles": ["submission-runtime"],
        }],
    }
    atomic_write(destination / ".judgedesk-package.json",
                 (json.dumps(receipt, indent=2) + "\n").encode(), 0o644)
    print("Verified Scratch executable SHA-256:", executable_sha256)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("sha256")
    parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    stage(arguments.archive, arguments.sha256, arguments.destination)
