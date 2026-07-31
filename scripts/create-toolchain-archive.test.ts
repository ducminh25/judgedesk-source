import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import test from "node:test";
import { extractToolchainArchive } from "../server/toolchains/installer.js";
import { extractToolchainReleaseArchive } from "./release-archive-extractor.js";

const python = process.env.JUDGEDESK_PACKAGING_PYTHON
  || (process.platform === "win32" ? "python" : "python3");
const script = path.join(
  process.cwd(),
  "scripts",
  "create-toolchain-archive.py",
);

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createArchive(
  root: string,
  output: string,
  format: "zip" | "tar.gz",
): SpawnSyncReturns<string> {
  return spawnSync(python, [script, root, output, format], {
    encoding: "utf8",
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: "1710000000",
    },
  });
}

for (const format of ["zip", "tar.gz"] as const) {
  test(`deterministic ${format} archives preserve the normalized package tree`, (t) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "judgedesk-archive-test-"),
    );
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const packageRoot = path.join(temporaryRoot, "package");
    fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "bin", "compiler"), "binary");
    fs.chmodSync(path.join(packageRoot, "bin", "compiler"), 0o755);
    fs.writeFileSync(path.join(packageRoot, "LICENSE"), "terms\n");

    const suffix = format === "zip" ? ".zip" : ".tar.gz";
    const first = path.join(temporaryRoot, `first${suffix}`);
    const second = path.join(temporaryRoot, `second${suffix}`);
    const firstRun = createArchive(packageRoot, first, format);
    const secondRun = createArchive(packageRoot, second, format);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(sha256(first), sha256(second));

    const extracted = path.join(temporaryRoot, "release-extracted");
    fs.mkdirSync(extracted);
    extractToolchainReleaseArchive(first, extracted, format);
    if (
      (process.platform === "win32" && format === "zip")
      || (process.platform !== "win32")
    ) {
      const runtimeExtracted = path.join(temporaryRoot, "runtime-extracted");
      extractToolchainArchive(first, runtimeExtracted, format);
      assert.equal(
        fs.readFileSync(
          path.join(runtimeExtracted, "bin", "compiler"),
          "utf8",
        ),
        "binary",
      );
    }
    assert.equal(
      fs.readFileSync(path.join(extracted, "bin", "compiler"), "utf8"),
      "binary",
    );
    assert.equal(
      fs.readFileSync(path.join(extracted, "LICENSE"), "utf8"),
      "terms\n",
    );
  });
}

test("archive creation rejects output inside the package root", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-archive-boundary-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporaryRoot, "runtime"), "binary");
  const result = createArchive(
    temporaryRoot,
    path.join(temporaryRoot, "nested.zip"),
    "zip",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the package root/);
});

test("release extraction rejects traversal and escaping archive links", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-release-extraction-boundary-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const traversalZip = path.join(temporaryRoot, "traversal.zip");
  const linkTar = path.join(temporaryRoot, "link.tar.gz");
  const fixture = spawnSync(
    python,
    [
      "-c",
      [
        "import sys, tarfile, zipfile",
        "with zipfile.ZipFile(sys.argv[1], 'w') as archive:",
        "    archive.writestr('../escaped.txt', 'unsafe')",
        "with tarfile.open(sys.argv[2], 'w:gz') as archive:",
        "    member = tarfile.TarInfo('compiler-link')",
        "    member.type = tarfile.SYMTYPE",
        "    member.linkname = '../../outside'",
        "    archive.addfile(member)",
      ].join("\n"),
      traversalZip,
      linkTar,
    ],
    { encoding: "utf8" },
  );
  assert.equal(fixture.status, 0, fixture.stderr);

  for (const [archivePath, format] of [
    [traversalZip, "zip"],
    [linkTar, "tar.gz"],
  ] as const) {
    const destination = fs.mkdtempSync(
      path.join(temporaryRoot, "extracted-"),
    );
    assert.throws(
      () => extractToolchainReleaseArchive(archivePath, destination, format),
      /unsafe path|symbolic link escapes the package root/,
    );
    assert.deepEqual(fs.readdirSync(destination), []);
  }
  assert.equal(
    fs.existsSync(path.join(temporaryRoot, "escaped.txt")),
    false,
  );
});

test("release extraction validates internal links and materializes them portably", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-release-internal-link-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const archivePath = path.join(temporaryRoot, "internal-link.tar.gz");
  const fixture = spawnSync(
    python,
    [
      "-c",
      [
        "import io, sys, tarfile",
        "payload = b'python-runtime'",
        "with tarfile.open(sys.argv[1], 'w:gz') as archive:",
        "    runtime = tarfile.TarInfo('bin/python3.12')",
        "    runtime.mode = 0o755",
        "    runtime.size = len(payload)",
        "    archive.addfile(runtime, io.BytesIO(payload))",
        "    link = tarfile.TarInfo('bin/python3')",
        "    link.type = tarfile.SYMTYPE",
        "    link.linkname = 'python3.12'",
        "    archive.addfile(link)",
      ].join("\n"),
      archivePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(fixture.status, 0, fixture.stderr);

  const destination = fs.mkdtempSync(
    path.join(temporaryRoot, "extracted-"),
  );
  const summary = extractToolchainReleaseArchive(
    archivePath,
    destination,
    "tar.gz",
  );
  const materializedLink = path.join(destination, "bin", "python3");
  assert.equal(fs.readFileSync(materializedLink, "utf8"), "python-runtime");
  assert.equal(fs.lstatSync(materializedLink).isSymbolicLink(), false);
  assert.deepEqual(summary, {
    fileCount: 2,
    installedSizeBytes:
      Buffer.byteLength("python-runtime")
      + Buffer.byteLength("python3.12"),
    materializedSizeBytes: 2 * Buffer.byteLength("python-runtime"),
  });
});

test("release extraction rejects portable-path collisions and file parents", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-release-portability-boundary-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const collisionZip = path.join(temporaryRoot, "collision.zip");
  const parentZip = path.join(temporaryRoot, "file-parent.zip");
  const fixture = spawnSync(
    python,
    [
      "-c",
      [
        "import sys, zipfile",
        "with zipfile.ZipFile(sys.argv[1], 'w') as archive:",
        "    archive.writestr('Bin/compiler', 'first')",
        "    archive.writestr('bin/compiler', 'second')",
        "with zipfile.ZipFile(sys.argv[2], 'w') as archive:",
        "    archive.writestr('runtime/tool', 'child-first')",
        "    archive.writestr('runtime', 'parent-file-second')",
      ].join("\n"),
      collisionZip,
      parentZip,
    ],
    { encoding: "utf8" },
  );
  assert.equal(fixture.status, 0, fixture.stderr);

  const collisionDestination = fs.mkdtempSync(
    path.join(temporaryRoot, "collision-extracted-"),
  );
  assert.throws(
    () => extractToolchainReleaseArchive(
      collisionZip,
      collisionDestination,
      "zip",
    ),
    /duplicate path/,
  );
  const parentDestination = fs.mkdtempSync(
    path.join(temporaryRoot, "parent-extracted-"),
  );
  assert.throws(
    () => extractToolchainReleaseArchive(
      parentZip,
      parentDestination,
      "zip",
    ),
    /below a regular file/,
  );
});
