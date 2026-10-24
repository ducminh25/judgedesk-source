#!/usr/bin/env python3
"""Exercise the baseline gate with real linker-created version requirements."""
import json
import hashlib
import stat
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


GATE = Path(__file__).with_name("verify-linux-elf-baseline.py")


class BaselineTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="jd-elf-test-")
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name)
        self.payload = self.work / "payload"
        self.payload.mkdir()

    def compile_version(self, version):
        (self.work / "provider.c").write_text("int jd_test_symbol(void) { return 0; }\n")
        (self.work / "versions.map").write_text(f"{version} {{ global: jd_test_symbol; }};\n")
        library = self.work / "libprovider.so"
        subprocess.run(["cc", "-shared", "-fPIC", str(self.work / "provider.c"),
                        f"-Wl,--version-script={self.work / 'versions.map'}", "-o", str(library)], check=True)
        (self.work / "consumer.c").write_text("extern int jd_test_symbol(void); int main(void) { return jd_test_symbol(); }\n")
        consumer = self.work / "consumer"
        subprocess.run(["cc", str(self.work / "consumer.c"), str(library), "-o", str(consumer)], check=True)
        return library, consumer

    def audit(self, catalog=None):
        report = self.work / "report.json"
        args = [sys.executable, str(GATE), str(self.payload), "--report", str(report)]
        if catalog is not None:
            args.extend(["--trusted-package-catalog", str(catalog)])
        result = subprocess.run(args,
                                text=True, capture_output=True)
        self.assertTrue(report.exists(), result.stderr)
        return result, json.loads(report.read_text())

    def pin_sysroot(self, consumer):
        package = self.payload / "toolchains/gcc-linux-x64"
        (package / "sysroot/lib").mkdir(parents=True)
        library = package / "sysroot/lib/libtest.so"
        shutil.copyfile(consumer, library)
        (package / ".judgedesk-package.json").write_text("fixture receipt")
        entries = []
        for item in sorted(package.rglob("*")):
            relative = item.relative_to(package).as_posix()
            entry = {"path": relative, "kind": "directory" if item.is_dir() else "file"}
            if item.is_file():
                entry.update(sizeBytes=item.stat().st_size,
                             executable=bool(stat.S_IMODE(item.stat().st_mode) & 0o111),
                             sha256=hashlib.sha256(item.read_bytes()).hexdigest())
            entries.append(entry)
        index = json.dumps({"schemaVersion": 1, "entries": entries}).encode()
        (package / ".judgedesk-content.json").write_bytes(index)
        catalog = self.work / "trusted-catalog.json"
        catalog.write_text(json.dumps({"schemaVersion": 1, "packages": [{
            "id": "gcc-linux-x64", "contentIndexSha256": hashlib.sha256(index).hexdigest(),
        }]}))
        return catalog, library

    def test_private_glibc_is_only_allowed_in_an_independently_pinned_compiler_sysroot(self):
        _, consumer = self.compile_version("GLIBC_PRIVATE")
        catalog, library = self.pin_sysroot(consumer)
        result, report = self.audit(catalog)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["files"][0]["role"], "compiler-sysroot-link-input")
        shutil.copyfile(library, self.payload / "desktop-library.so")
        result, report = self.audit(catalog)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("desktop-library.so", str(report["violations"]))
        (self.payload / "desktop-library.so").unlink()
        library.write_bytes(library.read_bytes() + b"drift")
        result, report = self.audit(catalog)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("content", str(report["violations"]).lower())

    def test_pinned_sysroot_cannot_raise_the_numeric_glibc_baseline(self):
        _, consumer = self.compile_version("GLIBC_2.36")
        catalog, _ = self.pin_sysroot(consumer)
        result, report = self.audit(catalog)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("GLIBC_2.36", str(report["violations"]))

    def test_installer_resources_reject_private_metadata_and_world_writable_files(self):
        _, consumer = self.compile_version("GLIBC_2.35")
        shutil.copyfile(consumer, self.payload / "helper")
        resources = self.payload / "usr/lib/JudgeDesk"
        resources.mkdir(parents=True)
        receipt = resources / ".judgedesk-package.json"
        receipt.write_text("receipt")
        receipt.chmod(0o600)
        result, report = self.audit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("permissions", str(report["violations"]))
        receipt.chmod(0o644)
        result, _ = self.audit()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt.chmod(0o777)
        result, report = self.audit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("permissions", str(report["violations"]))

    def test_catches_new_requirement_in_nested_extensionless_library(self):
        _, consumer = self.compile_version("GLIBC_2.36")
        nested = self.payload / "usr/lib/plugins"
        nested.mkdir(parents=True)
        shutil.copyfile(consumer, nested / "helper-without-extension")
        result, report = self.audit()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report["elfCount"], 1)
        self.assertIn("GLIBC_2.36", str(report["violations"]))

    def test_uses_requirements_not_exports_and_accepts_baseline(self):
        provider, _ = self.compile_version("GLIBC_99.0")
        shutil.copyfile(provider, self.payload / "exports-new-version.so")
        _, consumer = self.compile_version("GLIBC_2.35")
        shutil.copyfile(consumer, self.payload / "baseline")
        (self.payload / "README").write_text("GLIBC_99.0 is only text")
        (self.payload / "alias").symlink_to("baseline")
        result, report = self.audit()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["elfCount"], 2)
        self.assertEqual(report["maxRequiredGlibc"], "GLIBC_2.35")
        self.assertTrue(all(len(item["sha256"]) == 64 for item in report["files"]))

    def test_rejects_new_major_and_non_numeric_abi_requirement(self):
        for version in ("GLIBC_3.0", "GLIBC_ABI_DT_RELR", "GLIBC_PRIVATE"):
            with self.subTest(version=version):
                _, consumer = self.compile_version(version)
                shutil.copyfile(consumer, self.payload / "consumer")
                result, report = self.audit()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(version, str(report["violations"]))

    def test_rejects_corrupt_elf_and_empty_payload(self):
        result, report = self.audit()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report["elfCount"], 0)
        (self.payload / "broken").write_bytes(b"\x7fELFcorrupted")
        result, report = self.audit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("broken", str(report["violations"]))

    def test_accepts_static_elf_without_version_needs(self):
        source = self.work / "static.c"
        source.write_text("int main(void) { return 0; }\n")
        subprocess.run(["cc", "-static", str(source), "-o", str(self.payload / "static")], check=True)
        result, report = self.audit()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["files"][0]["requiredGlibc"], [])


if __name__ == "__main__":
    unittest.main()
