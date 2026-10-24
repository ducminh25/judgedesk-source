#!/usr/bin/env python3
"""Normalize pinned POSIX upstream archives at build time, never at app startup.

Use Python's maintained data extraction filter. Release archives continue to use
extract-toolchain-release-archive.py and its stricter cross-platform name rules.
"""
from pathlib import Path, PurePosixPath
import shutil
import posixpath
import stat
import sys
import tarfile

MAX_ENTRIES = 200_000
MAX_BYTES = 4 * 1024 * 1024 * 1024


def extract(archive: Path, destination: Path, python_runtime: bool = False, sysroot: bool = False, fpc_runtime: bool = False) -> None:
    if sysroot and sys.version_info < (3, 12):
        raise ValueError("Linux sysroot normalization requires build Python 3.12+ via JUDGEDESK_PACKAGING_PYTHON")
    if not hasattr(tarfile, "data_filter"):
        raise ValueError("Build Python requires the maintained tarfile.data_filter")
    if archive.is_symlink() or destination.exists() or destination.is_symlink():
        raise ValueError("Archive must be regular and extraction destination must be new")
    destination.mkdir(parents=True)
    seen = set()
    total = 0
    with tarfile.open(archive, "r:*") as source:
        members = source.getmembers()
        if len(members) > MAX_ENTRIES:
            raise ValueError("Upstream exceeds entry limit")
        retained = []
        for member in members:
            parts = PurePosixPath(member.name).parts
            if not parts and member.isdir():
                continue
            if not parts or parts[0] == "/" or ".." in parts or "\\" in member.name:
                raise ValueError(f"Unsafe upstream path: {member.name}")
            name = "/".join(parts)
            # Upstream FPC unit archives repeat documentation entries. Preserve
            # all compiler/units and retain licenses from the pinned source;
            # documentation examples are not part of the runtime package.
            if fpc_runtime and (name == "share/doc" or name.startswith("share/doc/")):
                continue
            if name in seen:
                raise ValueError(f"Duplicate upstream path: {member.name}")
            seen.add(name)
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError(f"Unsupported upstream entry: {member.name}")
            total += member.size
            if member.size < 0 or total > MAX_BYTES:
                raise ValueError("Upstream exceeds byte limit")
            # The standalone distribution's optional terminal database contains
            # non-relocatable links and case-colliding names. Judging is headless;
            # omit this data explicitly, never relax the link filter for it.
            if python_runtime and (name == "python/share/terminfo" or name.startswith("python/share/terminfo/")):
                continue
            if sysroot and member.issym() and member.linkname.startswith("/"):
                target = PurePosixPath(member.linkname)
                if ".." in target.parts or "\\" in member.linkname:
                    raise ValueError("Unsafe absolute sysroot link")
                member.linkname = posixpath.relpath(str(target).lstrip("/"), str(PurePosixPath(name).parent))
            retained.append(member)
        # The filter checks targets against the current extracted filesystem,
        # including earlier links, before each write. Do not replace with tar -xf.
        source.extractall(destination, members=retained, filter="data")


def materialize(source: Path, destination: Path) -> None:
    root = source.resolve(strict=True)
    if not root.is_dir() or destination.exists() or destination.is_symlink():
        raise ValueError("Materialization requires a directory and a new destination")
    count = 0
    total = 0

    def copy(current: Path, output: Path, ancestors: frozenset[Path]) -> None:
        nonlocal count, total
        resolved = current.resolve(strict=True)
        if resolved != root and root not in resolved.parents:
            raise ValueError(f"Upstream link escapes root: {current}")
        if resolved in ancestors:
            raise ValueError(f"Upstream link cycle: {current}")
        metadata = resolved.stat()
        count += 1
        if count > MAX_ENTRIES:
            raise ValueError("Materialized upstream exceeds entry limit")
        if stat.S_ISDIR(metadata.st_mode):
            output.mkdir(mode=0o755)
            for child in sorted(resolved.iterdir()):
                copy(child, output / child.name, ancestors | {resolved})
            # Tauri bundles resource files, not empty directories. Normalize
            # them before generating the signed package and content inventory.
            if output != destination and not any(output.iterdir()):
                output.rmdir()
        elif stat.S_ISREG(metadata.st_mode):
            total += metadata.st_size
            if total > MAX_BYTES:
                raise ValueError("Materialized upstream exceeds byte limit")
            with resolved.open("rb") as reader, output.open("xb") as writer:
                shutil.copyfileobj(reader, writer, length=1024 * 1024)
            output.chmod(0o755 if metadata.st_mode & 0o111 else 0o644)
        else:
            raise ValueError(f"Unsupported upstream file: {current}")

    copy(root, destination, frozenset())


if __name__ == "__main__":
    if len(sys.argv) not in {4, 5} or sys.argv[1] not in {"extract", "materialize"}:
        raise SystemExit("Usage: extract-linux-upstream.py <extract|materialize> <source> <new-destination>")
    try:
        if len(sys.argv) == 5:
            if sys.argv[1] != "extract" or sys.argv[4] not in {"--python-runtime", "--sysroot", "--fpc-runtime"}:
                raise ValueError("Unsupported upstream normalization option")
            extract(Path(sys.argv[2]), Path(sys.argv[3]),
                    python_runtime=sys.argv[4] == "--python-runtime", sysroot=sys.argv[4] == "--sysroot",
                    fpc_runtime=sys.argv[4] == "--fpc-runtime")
        else:
            {"extract": extract, "materialize": materialize}[sys.argv[1]](Path(sys.argv[2]), Path(sys.argv[3]))
    except (OSError, ValueError, tarfile.TarError) as error:
        raise SystemExit(str(error)) from error
