#!/usr/bin/env python3
"""Create deterministic JudgeDesk toolchain ZIP or tar.gz archives."""

from __future__ import annotations

import gzip
import os
from pathlib import Path
import shutil
import stat
import sys
import tarfile
import zipfile


def fail(message: str) -> "NoReturn":
    raise SystemExit(message)


def source_date_epoch() -> int:
    raw = os.environ.get("SOURCE_DATE_EPOCH", "")
    if not raw.isdigit():
        fail("SOURCE_DATE_EPOCH must be a non-negative integer.")
    value = int(raw)
    if value > 253402300799:
        fail("SOURCE_DATE_EPOCH is outside the supported timestamp range.")
    return value


def is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def package_entries(root: Path) -> list[tuple[Path, str]]:
    canonical_root = root.resolve(strict=True)
    entries: list[tuple[Path, str]] = []
    for current, directory_names, file_names in os.walk(
        root,
        topdown=True,
        followlinks=False,
    ):
        current_path = Path(current)
        retained_directories: list[str] = []
        for name in sorted(directory_names):
            entry = current_path / name
            relative = entry.relative_to(root).as_posix()
            entries.append((entry, relative))
            if entry.is_symlink():
                try:
                    target = entry.resolve(strict=True)
                except FileNotFoundError:
                    fail(f"Package contains a broken symbolic link: {relative}")
                if not is_within(canonical_root, target):
                    fail(f"Package symbolic link escapes its root: {relative}")
            else:
                retained_directories.append(name)
        directory_names[:] = retained_directories
        for name in sorted(file_names):
            entry = current_path / name
            relative = entry.relative_to(root).as_posix()
            if entry.is_symlink():
                try:
                    target = entry.resolve(strict=True)
                except FileNotFoundError:
                    fail(f"Package contains a broken symbolic link: {relative}")
                if not is_within(canonical_root, target):
                    fail(f"Package symbolic link escapes its root: {relative}")
            entries.append((entry, relative))
    entries.sort(key=lambda item: item[1])
    return entries


def normalized_mode(path: Path) -> int:
    mode = stat.S_IMODE(path.lstat().st_mode)
    if path.is_symlink():
        return 0o777
    if path.is_dir():
        return 0o755
    return 0o755 if mode & 0o111 else 0o644


def create_zip(
    root: Path,
    output: Path,
    epoch: int,
    entries: list[tuple[Path, str]],
) -> None:
    # ZIP cannot represent dates before 1980 or after 2107.
    safe_epoch = min(max(epoch, 315532800), 4354819199)
    timestamp = __import__("time").gmtime(safe_epoch)[:6]
    with output.open("xb") as raw_output:
        with zipfile.ZipFile(
            raw_output,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            for entry, relative in entries:
                is_directory = entry.is_dir() and not entry.is_symlink()
                archive_name = f"{relative}/" if is_directory else relative
                info = zipfile.ZipInfo(archive_name, date_time=timestamp)
                info.create_system = 3
                mode = normalized_mode(entry)
                file_type = (
                    stat.S_IFLNK
                    if entry.is_symlink()
                    else stat.S_IFDIR
                    if is_directory
                    else stat.S_IFREG
                )
                info.external_attr = ((file_type | mode) & 0xFFFF) << 16
                info.compress_type = (
                    zipfile.ZIP_STORED
                    if is_directory or entry.is_symlink()
                    else zipfile.ZIP_DEFLATED
                )
                if is_directory:
                    archive.writestr(info, b"")
                elif entry.is_symlink():
                    archive.writestr(info, os.readlink(entry).encode("utf-8"))
                else:
                    with entry.open("rb") as source, archive.open(info, "w") as target:
                        shutil.copyfileobj(source, target, length=1024 * 1024)


def create_tar_gz(
    root: Path,
    output: Path,
    epoch: int,
    entries: list[tuple[Path, str]],
) -> None:
    with output.open("xb") as raw_output:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            compresslevel=9,
            fileobj=raw_output,
            mtime=epoch,
        ) as compressed:
            with tarfile.open(
                fileobj=compressed,
                mode="w",
                format=tarfile.PAX_FORMAT,
            ) as archive:
                for entry, relative in entries:
                    info = archive.gettarinfo(str(entry), arcname=relative)
                    info.uid = 0
                    info.gid = 0
                    info.uname = "root"
                    info.gname = "root"
                    info.mtime = epoch
                    info.mode = normalized_mode(entry)
                    info.pax_headers = {}
                    if info.isfile():
                        with entry.open("rb") as source:
                            archive.addfile(info, source)
                    else:
                        archive.addfile(info)


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[3] not in {"zip", "tar.gz"}:
        fail(
            "Usage: create-toolchain-archive.py "
            "<package-root> <output-archive> <zip|tar.gz>"
        )
    root = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2]).resolve(strict=False)
    archive_format = sys.argv[3]
    if not root.is_dir():
        fail(f"Package root is not a directory: {root}")
    if output.exists():
        fail(f"Output archive already exists: {output}")
    if is_within(root, output):
        fail("Output archive must be outside the package root.")
    output.parent.mkdir(parents=True, exist_ok=True)
    epoch = source_date_epoch()
    entries = package_entries(root)
    if not entries:
        fail("Package root is empty.")
    if archive_format == "zip":
        create_zip(root, output, epoch, entries)
    else:
        create_tar_gz(root, output, epoch, entries)
    print(f"Created deterministic {archive_format} archive: {output}")


if __name__ == "__main__":
    main()
