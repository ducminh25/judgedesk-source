#!/usr/bin/env python3
"""Safely extract a JudgeDesk release archive on any publishing host."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import stat
import sys
import tarfile
from typing import BinaryIO, Callable, Literal, NoReturn
import unicodedata
import zipfile


MAX_ENTRIES = 500_000
MAX_INSTALLED_BYTES = 8 * 1024 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024
WINDOWS_RESERVED_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{number}" for number in range(1, 10)),
    *(f"lpt{number}" for number in range(1, 10)),
}
EntryKind = Literal["directory", "file", "symlink"]


@dataclass(frozen=True)
class ArchiveEntry:
    parts: tuple[str, ...]
    kind: EntryKind
    size: int
    mode: int
    source: object
    link_target: str | None = None


@dataclass(frozen=True)
class ExtractionPlan:
    entries_by_path: dict[tuple[str, ...], ArchiveEntry]
    file_count: int
    installed_size_bytes: int
    materialized_size_bytes: int


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def normalized_parts(raw_name: str) -> tuple[str, ...]:
    if not raw_name or len(raw_name) > 4096:
        fail("Archive contains an empty or oversized path.")
    if "\\" in raw_name or "\0" in raw_name:
        fail(f"Archive contains an unsafe path: {raw_name!r}")
    name = raw_name[:-1] if raw_name.endswith("/") else raw_name
    raw_parts = name.split("/")
    if (
        not name
        or name.startswith("/")
        or not raw_parts
        or any(part in {"", ".", ".."} for part in raw_parts)
    ):
        fail(f"Archive contains an unsafe path: {raw_name!r}")
    for part in raw_parts:
        if (
            ":" in part
            or part.endswith((" ", "."))
            or part.split(".", 1)[0].rstrip(" .").casefold()
            in WINDOWS_RESERVED_NAMES
        ):
            fail(f"Archive contains a non-portable path: {raw_name!r}")
    return tuple(raw_parts)


def normalized_mode(mode: int, is_directory: bool) -> int:
    if is_directory:
        return 0o755
    return 0o755 if mode & 0o111 else 0o644


def canonical_parts(parts: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(
        unicodedata.normalize("NFD", part).casefold()
        for part in parts
    )


def resolve_link_target_parts(entry: ArchiveEntry) -> tuple[str, ...]:
    target = entry.link_target
    if (
        not target
        or len(target) > 4096
        or target.startswith("/")
        or "\\" in target
        or "\0" in target
        or ":" in target
    ):
        fail(f"Archive contains an unsafe symbolic link: {'/'.join(entry.parts)}")
    resolved = list(entry.parts[:-1])
    for part in target.split("/"):
        if part in {"", "."}:
            continue
        if part == "..":
            if not resolved:
                fail(
                    "Archive symbolic link escapes the package root: "
                    f"{'/'.join(entry.parts)}"
                )
            resolved.pop()
            continue
        resolved.append(part)
    if not resolved:
        fail(
            "Archive symbolic link resolves to the package root: "
            f"{'/'.join(entry.parts)}"
        )
    return tuple(resolved)


def resolve_link_entry(
    entry: ArchiveEntry,
    entries_by_path: dict[tuple[str, ...], ArchiveEntry],
    seen: set[tuple[str, ...]] | None = None,
) -> ArchiveEntry:
    if entry.kind != "symlink":
        return entry
    visited = set() if seen is None else seen
    if entry.parts in visited:
        fail(f"Archive contains a symbolic-link cycle: {'/'.join(entry.parts)}")
    visited.add(entry.parts)
    target_parts = resolve_link_target_parts(entry)
    target = entries_by_path.get(target_parts)
    if target is None:
        fail(f"Archive contains a broken symbolic link: {'/'.join(entry.parts)}")
    if target.kind == "directory":
        fail(
            "Archive directory symbolic links are not supported: "
            f"{'/'.join(entry.parts)}"
        )
    return resolve_link_entry(target, entries_by_path, visited)


def assert_plan_is_safe(
    entries: list[ArchiveEntry],
) -> ExtractionPlan:
    if not entries or len(entries) > MAX_ENTRIES:
        fail("Archive has an invalid entry count.")
    installed_size_bytes = 0
    materialized_size_bytes = 0
    kinds: dict[tuple[str, ...], EntryKind] = {}
    canonical_paths: set[tuple[str, ...]] = set()
    entries_by_path: dict[tuple[str, ...], ArchiveEntry] = {}
    for entry in entries:
        canonical = canonical_parts(entry.parts)
        if canonical in canonical_paths:
            fail(f"Archive contains a duplicate path: {'/'.join(entry.parts)}")
        canonical_paths.add(canonical)
        entries_by_path[entry.parts] = entry
        kinds[canonical] = entry.kind
        if entry.size < 0:
            fail("Archive contains an entry with a negative size.")
        installed_size_bytes += entry.size
        materialized_size_bytes += entry.size
        if installed_size_bytes > MAX_INSTALLED_BYTES:
            fail("Archive exceeds the installed-size limit.")
    for entry in entries:
        canonical = canonical_parts(entry.parts)
        for index in range(1, len(canonical)):
            parent = canonical[:index]
            if parent in kinds and kinds[parent] != "directory":
                fail(
                    "Archive places an entry below a regular file: "
                    f"{'/'.join(entry.parts)}"
                )
    for entry in entries:
        if entry.kind != "symlink":
            continue
        target = resolve_link_entry(entry, entries_by_path)
        assert entry.link_target is not None
        installed_size_bytes += len(entry.link_target.encode("utf-8"))
        materialized_size_bytes += target.size
        if (
            installed_size_bytes > MAX_INSTALLED_BYTES
            or materialized_size_bytes > MAX_INSTALLED_BYTES
        ):
            fail("Archive exceeds the installed-size limit.")
    return ExtractionPlan(
        entries_by_path=entries_by_path,
        file_count=sum(entry.kind != "directory" for entry in entries),
        installed_size_bytes=installed_size_bytes,
        materialized_size_bytes=materialized_size_bytes,
    )


def copy_exact(source: BinaryIO, destination: Path, expected_size: int) -> None:
    copied = 0
    with destination.open("xb") as output:
        while True:
            chunk = source.read(COPY_CHUNK_BYTES)  # type: ignore[attr-defined]
            if not chunk:
                break
            copied += len(chunk)
            if copied > expected_size:
                fail(f"Archive entry expanded beyond its declared size: {destination}")
            output.write(chunk)
    if copied != expected_size:
        fail(f"Archive entry size verification failed: {destination}")


def extract_zip(archive_path: Path, destination: Path) -> ExtractionPlan:
    with zipfile.ZipFile(archive_path, "r") as archive:
        entries: list[ArchiveEntry] = []
        for info in archive.infolist():
            if len(entries) >= MAX_ENTRIES:
                fail("Archive has an invalid entry count.")
            if info.flag_bits & 0x1:
                fail("Encrypted ZIP entries are not supported.")
            parts = normalized_parts(info.filename)
            raw_mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(raw_mode)
            is_directory = info.is_dir()
            if file_type == stat.S_IFLNK:
                if is_directory or info.file_size > 4096:
                    fail(f"Archive has an invalid symbolic link: {info.filename}")
                with archive.open(info, "r") as source:
                    raw_target = source.read(4097)
                if len(raw_target) != info.file_size:
                    fail(f"Archive link size verification failed: {info.filename}")
                try:
                    link_target = raw_target.decode("utf-8", errors="strict")
                except UnicodeDecodeError:
                    fail(
                        "Archive symbolic link target is not UTF-8: "
                        f"{info.filename}"
                    )
                entries.append(
                    ArchiveEntry(
                        parts=parts,
                        kind="symlink",
                        size=0,
                        mode=raw_mode,
                        source=info,
                        link_target=link_target,
                    )
                )
                continue
            if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
                fail(f"Archive contains a special file: {info.filename}")
            if file_type == stat.S_IFDIR and not is_directory:
                fail(f"Archive directory metadata is inconsistent: {info.filename}")
            entries.append(
                ArchiveEntry(
                    parts=parts,
                    kind="directory" if is_directory else "file",
                    size=0 if is_directory else info.file_size,
                    mode=raw_mode,
                    source=info,
                )
            )
        plan = assert_plan_is_safe(entries)
        materialize(
            entries,
            plan.entries_by_path,
            destination,
            lambda source: archive.open(source, "r"),
        )
        return plan


def extract_tar(archive_path: Path, destination: Path) -> ExtractionPlan:
    with tarfile.open(archive_path, mode="r:*") as archive:
        entries: list[ArchiveEntry] = []
        for member in archive:
            if len(entries) >= MAX_ENTRIES:
                fail("Archive has an invalid entry count.")
            parts = normalized_parts(member.name)
            if member.islnk():
                fail(f"Archive hard links are not permitted: {member.name}")
            if member.issym():
                entries.append(
                    ArchiveEntry(
                        parts=parts,
                        kind="symlink",
                        size=0,
                        mode=member.mode,
                        source=member,
                        link_target=member.linkname,
                    )
                )
                continue
            if not member.isdir() and not member.isfile():
                fail(f"Archive contains a special file: {member.name}")
            entries.append(
                ArchiveEntry(
                    parts=parts,
                    kind="directory" if member.isdir() else "file",
                    size=0 if member.isdir() else member.size,
                    mode=member.mode,
                    source=member,
                )
            )
        plan = assert_plan_is_safe(entries)

        def open_member(source: object) -> BinaryIO:
            stream = archive.extractfile(source)  # type: ignore[arg-type]
            if stream is None:
                fail("Unable to read a regular TAR entry.")
            return stream

        materialize(entries, plan.entries_by_path, destination, open_member)
        return plan


def materialize(
    entries: list[ArchiveEntry],
    entries_by_path: dict[tuple[str, ...], ArchiveEntry],
    destination: Path,
    open_source: Callable[[object], BinaryIO],
) -> None:
    for entry in sorted(
        entries,
        key=lambda candidate: (len(candidate.parts), candidate.parts),
    ):
        if entry.kind != "directory":
            continue
        output = destination.joinpath(*entry.parts)
        output.mkdir(parents=True, exist_ok=False)
        output.chmod(normalized_mode(entry.mode, True))
    for entry in entries:
        if entry.kind != "file":
            continue
        output = destination.joinpath(*entry.parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        stream = open_source(entry.source)
        try:
            copy_exact(stream, output, entry.size)
        finally:
            stream.close()
        output.chmod(normalized_mode(entry.mode, False))
    for entry in entries:
        if entry.kind != "symlink":
            continue
        target = resolve_link_entry(entry, entries_by_path)
        target_path = destination.joinpath(*target.parts)
        output = destination.joinpath(*entry.parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        with target_path.open("rb") as source:
            copy_exact(source, output, target.size)
        output.chmod(normalized_mode(target.mode, False))


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[3] not in {"zip", "tar.gz"}:
        fail(
            "Usage: extract-toolchain-release-archive.py "
            "<archive> <empty-destination> <zip|tar.gz>"
        )
    supplied_archive = Path(sys.argv[1])
    supplied_destination = Path(sys.argv[2])
    if supplied_archive.is_symlink() or supplied_destination.is_symlink():
        fail("Archive and extraction destination must not be symbolic links.")
    archive_path = supplied_archive.resolve(strict=True)
    destination = supplied_destination.resolve(strict=True)
    archive_format = sys.argv[3]
    if not archive_path.is_file():
        fail("Archive must be a regular file.")
    if not destination.is_dir() or any(destination.iterdir()):
        fail("Extraction destination must be an existing empty directory.")
    plan = (
        extract_zip(archive_path, destination)
        if archive_format == "zip"
        else extract_tar(archive_path, destination)
    )
    print(
        json.dumps(
            {
                "fileCount": plan.file_count,
                "installedSizeBytes": plan.installed_size_bytes,
                "materializedSizeBytes": plan.materialized_size_bytes,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
