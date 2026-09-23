import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStandardChecker } from "../server/judge/standard-checkers.js";

function main() {
  console.log("=== [E2E Verification] BAI5 Themis C1 Parity Check ===");

  const testBase =
    process.env.BAI5_TEST_DIR ||
    (process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "");
  const studentCpp =
    process.env.BAI5_STUDENT_CPP ||
    (process.argv[3] && !process.argv[3].startsWith("-") ? process.argv[3] : "");
  const c1Exe = path.resolve("judgers/C1.exe");

  if (!testBase || !studentCpp || !fs.existsSync(testBase) || !fs.existsSync(studentCpp)) {
    console.error("[verify-bai5-e2e] ERROR: Missing or invalid required arguments/environment variables.");
    console.error(`  BAI5_TEST_DIR (arg 1): ${testBase ? testBase : "(not set)"} (${fs.existsSync(testBase) ? "found" : "missing"})`);
    console.error(`  BAI5_STUDENT_CPP (arg 2): ${studentCpp ? studentCpp : "(not set)"} (${fs.existsSync(studentCpp) ? "found" : "missing"})`);
    console.error("");
    console.error("Usage:");
    console.error("  npx tsx scripts/verify-bai5-e2e.ts <path/to/Test/BAI5> <path/to/BAI5.CPP>");
    console.error("  or set BAI5_TEST_DIR and BAI5_STUDENT_CPP environment variables.");
    process.exit(1);
  }
  assert.ok(fs.existsSync(c1Exe), `Missing C1.exe: ${c1Exe}`);



  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-bai5-e2e-"));
  const solExe = path.join(tempDir, "BAI5_sol.exe");
  const dummyInput = path.join(tempDir, "dummy.inp");
  fs.writeFileSync(dummyInput, "");

  try {
    console.log("[1/4] Compiling student submission with g++ -O3...");
    execSync(`g++ -O3 "${studentCpp}" -o "${solExe}"`, { cwd: tempDir });
    assert.ok(fs.existsSync(solExe));

    console.log("[2/4] Executing student binary and validating against C1 (Node & C1.exe)...");
    for (let i = 0; i < 10; i++) {
      const testName = "test" + String(i).padStart(2, "0");
      const caseDir = path.join(tempDir, testName);
      fs.mkdirSync(caseDir, { recursive: true });

      const inpSrc = path.join(testBase, testName, "BAI5.inp");
      const outSrc = path.join(testBase, testName, "BAI5.out");
      assert.ok(fs.existsSync(inpSrc), `Missing ${inpSrc}`);
      assert.ok(fs.existsSync(outSrc), `Missing ${outSrc}`);

      const inpDst = path.join(caseDir, "BAI5.INP");
      fs.copyFileSync(inpSrc, inpDst);

      // Run student binary
      const run = spawnSync(solExe, [], { cwd: caseDir, timeout: 5000, stdio: "ignore" });
      assert.equal(run.status, 0, `Execution failed on ${testName}`);

      const actualOutFile = path.join(caseDir, "BAI5.OUT");
      assert.ok(fs.existsSync(actualOutFile), `BAI5.OUT missing for ${testName}`);

      const actualBytes = fs.readFileSync(actualOutFile);
      const expectedBytes = fs.readFileSync(outSrc);

      // Check with Node runStandardChecker
      const nodeRes = runStandardChecker("C1", expectedBytes, actualBytes);
      assert.equal(
        nodeRes.status,
        "AC",
        `Node C1 failed on ${testName}: status=${nodeRes.status}, message=${nodeRes.message}`,
      );
      assert.equal(
        nodeRes.message,
        "single line",
        `Node C1 message mismatch on ${testName}: got ${nodeRes.message}`,
      );

      // Check with rebuilt C1.exe
      const c1Run = spawnSync(c1Exe, [dummyInput, actualOutFile, outSrc], {
        encoding: "utf8",
        cwd: caseDir,
      });
      assert.equal(c1Run.status, 0, `C1.exe exited with ${c1Run.status} on ${testName}: ${c1Run.stderr}`);
      const c1Out = (c1Run.stdout + " " + c1Run.stderr).trim();
      assert.ok(c1Out.includes("ok single line"), `C1.exe output mismatch on ${testName}: ${c1Out}`);

      console.log(`  ✔ ${testName}: 1.0000 / 1.0000 AC [single line] (out: ${actualBytes.toString().trim()})`);
    }

    console.log("[3/4] Verifying leading blank line edge case...");
    const sampleExp = fs.readFileSync(path.join(testBase, "test00", "BAI5.out"));
    const leadingActual = Buffer.concat([Buffer.from("\r\n"), sampleExp]);
    const leadingRes = runStandardChecker("C1", sampleExp, leadingActual);
    assert.equal(leadingRes.status, "WA");
    assert.equal(leadingRes.message, "Wrong answer at line 1");

    const leadingFile = path.join(tempDir, "leading.out");
    fs.writeFileSync(leadingFile, leadingActual);
    const c1Leading = spawnSync(c1Exe, [dummyInput, leadingFile, path.join(testBase, "test00", "BAI5.out")], {
      encoding: "utf8",
    });
    assert.equal(c1Leading.status, 1, "C1.exe should return 1 for WA");
    assert.ok((c1Leading.stdout + c1Leading.stderr).includes("Wrong answer at line 1"));
    console.log("  ✔ Leading blank line correctly produces WA at line 1");

    console.log("[4/4] Verifying trailing blank lines edge case...");
    const trailingActual = Buffer.concat([sampleExp, Buffer.from("\r\n\r\n\r\n")]);
    const trailingRes = runStandardChecker("C1", sampleExp, trailingActual);
    assert.equal(trailingRes.status, "AC");
    assert.equal(trailingRes.message, "single line");

    const trailingFile = path.join(tempDir, "trailing.out");
    fs.writeFileSync(trailingFile, trailingActual);
    const c1Trailing = spawnSync(c1Exe, [dummyInput, trailingFile, path.join(testBase, "test00", "BAI5.out")], {
      encoding: "utf8",
    });
    assert.equal(c1Trailing.status, 0, "C1.exe should return 0 for AC");
    assert.ok((c1Trailing.stdout + c1Trailing.stderr).includes("ok single line"));
    console.log("  ✔ Trailing blank lines correctly produces AC single line");

    console.log("\n=======================================================");
    console.log(">>> ALL E2E CHECKS PASSED: 10/10 AC (SINGLE LINE)! <<<");
    console.log("=======================================================");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
