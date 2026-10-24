"""Build-time verification of expanded packages against an external trust catalog."""
import hashlib
import json
from pathlib import Path
import re
import stat

INDEX_NAME = ".judgedesk-content.json"
MAX_ENTRIES = 200_000
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_package(package, pin):
    if package.is_symlink() or not package.is_dir():
        raise ValueError("content root is not a regular directory")
    index_path = package / INDEX_NAME
    if index_path.is_symlink() or index_path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError("invalid content index file")
    raw = index_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != pin["contentIndexSha256"]:
        raise ValueError("content index differs from the external trusted digest")
    index = json.loads(raw)
    entries = index.get("entries", [])
    if index.get("schemaVersion") != 1 or not 0 < len(entries) <= MAX_ENTRIES:
        raise ValueError("invalid content index schema or count")
    expected = {}
    total_bytes = 0
    for entry in entries:
        name = entry.get("path", "")
        if (not name or name.startswith("/") or "\\" in name
                or any(part in {"", ".", ".."} for part in name.split("/"))
                or any(ord(char) < 32 for char in name) or name == INDEX_NAME or name in expected):
            raise ValueError("unsafe or duplicate content path")
        path = package / name
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(f"symbolic link in content: {name}")
        if entry.get("kind") == "directory":
            if not stat.S_ISDIR(metadata.st_mode):
                raise ValueError(f"content directory type drift: {name}")
        elif entry.get("kind") == "file":
            size = entry.get("sizeBytes")
            digest = entry.get("sha256", "")
            total_bytes += size if type(size) is int else MAX_TOTAL_BYTES + 1
            if (type(size) is not int or not 0 <= size <= MAX_FILE_BYTES
                    or total_bytes > MAX_TOTAL_BYTES or not re.fullmatch(r"[a-f0-9]{64}", digest)
                    or not stat.S_ISREG(metadata.st_mode) or metadata.st_size != size
                    or type(entry.get("executable")) is not bool
                    or bool(metadata.st_mode & 0o111) != entry["executable"]
                    or file_hash(path) != digest):
                raise ValueError(f"content file drift: {name}")
        else:
            raise ValueError("unknown content entry kind")
        expected[name] = entry
    actual = set()
    pending = [package]
    while pending:
        directory = pending.pop()
        for path in directory.iterdir():
            relative = path.relative_to(package).as_posix()
            if relative == INDEX_NAME:
                continue
            if path.is_symlink():
                raise ValueError("symbolic link in content tree")
            actual.add(relative)
            if len(actual) > MAX_ENTRIES:
                raise ValueError("content entry count exceeded")
            if path.is_dir():
                pending.append(path)
    if actual != set(expected):
        raise ValueError("content tree has missing or additional entries")
    return expected


def verified_sysroot_files(root, catalog_path):
    if root.is_file():
        return {}, []
    catalog_path = catalog_path.resolve()
    if catalog_path == root or root in catalog_path.parents:
        return {}, [{"error": "trust catalog must be independent of the inspected payload"}]
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    pins = {pin["id"]: pin for pin in catalog["packages"]}
    allowed, violations = {}, []
    for index in root.rglob(INDEX_NAME):
        package = index.parent
        pin = pins.get(package.name)
        if pin is None:
            violations.append({"path": str(index), "error": "untrusted package content index"})
            continue
        try:
            expected = verify_package(package, pin)
            if package.name not in {"gcc-linux-x64", "fpc-linux-x64"}:
                continue
            for relative, entry in expected.items():
                if relative.startswith("sysroot/") and entry["kind"] == "file":
                    allowed[(package / relative).resolve()] = entry["sha256"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            violations.append({"path": str(index), "error": f"package content verification failed: {error}"})
    return allowed, violations
