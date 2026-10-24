#!/usr/bin/env python3
"""Audit every regular ELF in a package tree against Ubuntu 22.04 GLIBC 2.35."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from linux_toolchain_integrity import verified_sysroot_files


BASELINE = (2, 35)


def resource_permission_violations(root):
    violations = []
    if not root.is_dir():
        return violations
    for resources in root.rglob("JudgeDesk"):
        if resources.parts[-3:] != ("usr", "lib", "JudgeDesk"):
            continue
        for item in [resources, *resources.rglob("*")]:
            mode = item.lstat().st_mode
            expected = 0o755 if stat.S_ISDIR(mode) or mode & 0o111 else 0o644
            if (not (stat.S_ISDIR(mode) or stat.S_ISREG(mode))
                    or stat.S_IMODE(mode) != expected):
                violations.append({"path": item.relative_to(root).as_posix(),
                                   "error": "invalid installer resource permissions"})
    return violations


def version_needs(output):
    needs = set()
    in_needs = False
    for line in output.splitlines():
        if line.startswith("Version "):
            in_needs = line.startswith("Version needs section ")
        if in_needs:
            needs.update(re.findall(r"\bName: (GLIBC_\S+)", line))
    return sorted(needs)


def audit(root, trusted_catalog=None):
    root = root.resolve()
    catalog = trusted_catalog or Path(__file__).resolve().parent.parent / "shared/linux-full-package-trust.json"
    try:
        sysroot_files, violations = verified_sysroot_files(root, catalog)
    except (OSError, ValueError, KeyError, TypeError) as error:
        sysroot_files, violations = {}, [{"error": f"cannot validate external package trust catalog: {error}"}]
    violations.extend(resource_permission_violations(root))
    files, all_versions = [], []
    candidates = [root] if root.is_file() else sorted(root.rglob("*"))
    for path in candidates:
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as source:
            if source.read(4) != b"\x7fELF":
                continue
        name = path.name if root.is_file() else path.relative_to(root).as_posix()
        result = subprocess.run(["readelf", "--wide", "--version-info", str(path)],
                                capture_output=True, text=True,
                                env={**os.environ, "LC_ALL": "C"})
        entry = {"path": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                 "requiredGlibc": []}
        files.append(entry)
        is_pinned_link_input = sysroot_files.get(path.resolve()) == entry["sha256"]
        entry["role"] = "compiler-sysroot-link-input" if is_pinned_link_input else "runtime"
        if result.returncode or result.stderr.strip():
            violations.append({"path": name, "error": result.stderr.strip() or "readelf failed"})
            continue
        requirements = version_needs(result.stdout)
        entry["requiredGlibc"] = requirements
        for requirement in requirements:
            # The paired glibc files in a verified compiler sysroot are linker
            # inputs. They must never become the desktop/runtime search path.
            # Every runnable/unpinned ELF still rejects private ABI requirements.
            if requirement == "GLIBC_PRIVATE" and is_pinned_link_input:
                continue
            numeric = re.fullmatch(r"GLIBC_(\d+(?:\.\d+)+)", requirement)
            if numeric is None:
                violations.append({"path": name, "requirement": requirement,
                                   "error": "unsupported GLIBC ABI requirement"})
                continue
            version = tuple(map(int, numeric[1].split(".")))
            all_versions.append((version, requirement))
            if version > BASELINE:
                violations.append({"path": name, "requirement": requirement,
                                   "error": "exceeds GLIBC_2.35"})
    if not files:
        violations.append({"error": "no ELF files inspected"})
    return {"schemaVersion": 1, "root": str(root.resolve()), "baseline": "GLIBC_2.35",
            "elfCount": len(files), "maxRequiredGlibc": max(all_versions)[1] if all_versions else None,
            "files": files, "violations": violations, "passed": not violations}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--trusted-package-catalog", type=Path)
    args = parser.parse_args()
    report = audit(args.root, args.trusted_package_catalog)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"ELF baseline {'PASS' if report['passed'] else 'FAIL'}: {report['elfCount']} ELF, "
          f"max {report['maxRequiredGlibc']}; {args.report}")
    for violation in report["violations"]:
        print(json.dumps(violation), file=sys.stderr)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
