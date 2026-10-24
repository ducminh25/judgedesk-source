#!/usr/bin/env python3
"""Exercise upstream normalization without changing the stricter release format."""
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


class UpstreamExtractionTest(unittest.TestCase):
    def run_archive(self, entries):
        temporary = tempfile.TemporaryDirectory(prefix="judgedesk-upstream-test-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        archive = root / "upstream.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for name, content, link in entries:
                info = tarfile.TarInfo(name)
                info.mode = 0o755
                if link is not None:
                    info.type = tarfile.SYMTYPE
                    info.linkname = link
                    output.addfile(info)
                else:
                    data = content.encode()
                    info.size = len(data)
                    output.addfile(info, io.BytesIO(data))
        destination = root / "extracted"
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("extract-linux-upstream.py")),
             "extract", str(archive), str(destination)],
            capture_output=True, text=True,
        )
        return result, destination

    def test_preserves_case_distinct_posix_names(self):
        result, destination = self.run_archive([("root/A", "one", None), ("root/a", "two", None)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((destination / "root/A").read_text(), "one")
        self.assertEqual((destination / "root/a").read_text(), "two")

    def test_rejects_path_traversal(self):
        result, _ = self.run_archive([("../escape", "bad", None)])
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_symlink_escape_before_write(self):
        result, _ = self.run_archive([("root/link", "", "../../outside"), ("root/link/file", "bad", None)])
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_duplicate_exact_path(self):
        result, _ = self.run_archive([("root/file", "first", None), ("root/file", "second", None)])
        self.assertNotEqual(result.returncode, 0)

    def test_materializes_internal_directory_link(self):
        result, destination = self.run_archive([("root/real/file", "ok", None), ("root/alias", "", "real")])
        self.assertEqual(result.returncode, 0, result.stderr)
        normalized = destination.parent / "normalized"
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("extract-linux-upstream.py")),
             "materialize", str(destination / "root"), str(normalized)], capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((normalized / "alias").is_symlink())
        self.assertEqual((normalized / "alias/file").read_text(), "ok")

    def test_materialization_omits_empty_directories_dropped_by_tauri_resources(self):
        with tempfile.TemporaryDirectory(prefix="judgedesk-empty-resource-") as temporary:
            root = Path(temporary)
            source = root / "source"
            (source / "share/doc").mkdir(parents=True)
            (source / "bin").mkdir()
            (source / "bin/compiler").write_text("payload")
            destination = root / "normalized"
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("extract-linux-upstream.py")),
                "materialize", str(source), str(destination)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((destination / "share").exists())
            self.assertEqual((destination / "bin/compiler").read_text(), "payload")

    def test_rejects_link_cycle(self):
        result, destination = self.run_archive([("root/file", "ok", None), ("root/cycle", "", ".")])
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("extract-linux-upstream.py")),
             "materialize", str(destination / "root"), str(destination.parent / "normalized")], capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)


class LinuxReleaseNamesTest(unittest.TestCase):
    def test_posix_names_require_explicit_linux_mode(self):
        with tempfile.TemporaryDirectory(prefix="judgedesk-release-names-") as temporary:
            root = Path(temporary)
            archive = root / "headers.tar.gz"
            with tarfile.open(archive, "w:gz") as output:
                for name in ["include/xt_CONNMARK.h", "include/xt_connmark.h"]:
                    entry = tarfile.TarInfo(name)
                    entry.size = 1
                    output.addfile(entry, io.BytesIO(b"x"))
            for posix in [False, True]:
                destination = root / ("linux" if posix else "portable")
                destination.mkdir()
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).with_name("extract-toolchain-release-archive.py")),
                     str(archive), str(destination), "tar.gz", *(["--linux-posix-names"] if posix else [])],
                    capture_output=True, text=True,
                )
                if posix:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue((destination / "include/xt_CONNMARK.h").is_file())
                    self.assertTrue((destination / "include/xt_connmark.h").is_file())
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("duplicate path", result.stderr)


if __name__ == "__main__":
    unittest.main()
