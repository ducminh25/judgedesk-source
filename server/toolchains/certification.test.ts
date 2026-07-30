import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSupportedGnuCppIdentity,
  parseGnuCppIdentity,
  planLocalCppCertification,
} from "./certification.js";

test("GNU C++ identity parsing keeps exact build, distributor, version, and target", () => {
  assert.deepEqual(
    parseGnuCppIdentity(
      "g++.exe (Rev5, Built by MSYS2 project) 16.1.0\nCopyright...\n",
      "x86_64-w64-mingw32\n",
    ),
    {
      family: "gcc",
      version: "16.1.0",
      build: "g++.exe (Rev5, Built by MSYS2 project) 16.1.0",
      distributor: "MSYS2 project",
      target: "x86_64-w64-mingw32",
    },
  );
  assert.deepEqual(
    parseGnuCppIdentity(
      "g++.exe (MinGW.org GCC Build-2) 9.2.0\n",
      "mingw32\n",
    ),
    {
      family: "gcc",
      version: "9.2.0",
      build: "g++.exe (MinGW.org GCC Build-2) 9.2.0",
      distributor: "MinGW.org",
      target: "mingw32",
    },
  );
});

test("GNU C++ certification policy is an exact tested allowlist", () => {
  assert.doesNotThrow(() => assertSupportedGnuCppIdentity({
    family: "gcc",
    version: "14.2.0",
    build: "g++ 14.2.0",
    target: "x86_64-w64-mingw32",
  }));
  assert.throws(() => assertSupportedGnuCppIdentity({
    family: "gcc",
    version: "9.2.0",
    build: "g++.exe (MinGW.org GCC Build-2) 9.2.0",
    target: "mingw32",
  }), /outside JudgeDesk's exact tested versions/);
  assert.throws(() => assertSupportedGnuCppIdentity({
    family: "gcc",
    version: "99.0.0",
    build: "g++ 99.0.0",
    target: "x86_64-w64-mingw32",
  }), /outside JudgeDesk's exact tested versions/);
  assert.throws(
    () => parseGnuCppIdentity("Apple clang version 17.0.0", "arm64-apple-darwin"),
    /does not identify as GNU g\+\+/,
  );
});

test("local C++ certification plan derives a bounded whole-root snapshot", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-cert-plan-"));
  try {
    const bin = path.join(temporary, "bin");
    fs.mkdirSync(bin);
    const compiler = path.join(bin, "g++.exe");
    fs.writeFileSync(compiler, "compiler");
    fs.writeFileSync(path.join(temporary, "support.a"), "support");
    const plan = await planLocalCppCertification(compiler, { platform: "win32" });
    assert.equal(plan.mode, "local-snapshot");
    assert.equal(plan.sourceRoot, fs.realpathSync(temporary));
    assert.equal(plan.relativeExecutablePath, "bin/g++.exe");
    assert.equal(plan.fileCount, 2);
    assert.equal(plan.totalBytes, 15);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
