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

    const extracted = path.join(temporaryRoot, "extracted");
    if (process.platform === "win32" && format === "tar.gz") {
      fs.mkdirSync(extracted);
      const extraction = spawnSync(
        "tar",
        ["-xf", first, "-C", extracted],
        { encoding: "utf8" },
      );
      assert.equal(extraction.status, 0, extraction.stderr);
    } else {
      extractToolchainArchive(first, extracted, format);
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
