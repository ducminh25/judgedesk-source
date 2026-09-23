import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

import {
  assertOracleBaselineIntegrity,
  validateOracleBaselineIntegrity,
} from "./oracle-baseline-validator.js";
import type {
  Corpus,
  CorpusFixture,
  ThemisOracleArtifactPayload,
  ThemisOracleCorpusBinding,
  ThemisOracleExecution,
  ThemisOracleProductDecision,
  ThemisOracleResultEntry,
} from "./oracle-baseline-validator.js";

export {
  assertOracleBaselineIntegrity,
  validateOracleBaselineIntegrity,
};
export type {
  Corpus,
  CorpusFixture,
  ThemisOracleArtifactPayload,
  ThemisOracleCorpusBinding,
  ThemisOracleExecution,
  ThemisOracleProductDecision,
  ThemisOracleResultEntry,
};

const CHECKER_DLLS: Record<"C1" | "C2" | "C3" | "C4" | "C5", string> = {
  C1: "C1LinesWordsIgnoreCase.dll",
  C2: "C2LinesWordsCase.dll",
  C3: "C3WordsIgnoreCase.dll",
  C4: "C4WordsCase.dll",
  C5: "C5Binary.dll",
};

const C5_PRODUCT_DECISION: ThemisOracleProductDecision = {
  decision: "INTENTIONALLY_NOT_EMULATED",
  rationale:
    "Delphi off-by-one loop bug in C5Binary.dll: The binary comparison loop is compiled from 'for i := 0 to FileSize do', which executes FileSize + 1 times in Pascal. On the (FileSize + 1)-th iteration, it reads past EOF, raising STATUS_ACCESS_VIOLATION at address 0x00000000. Delphi catches the exception and returns score 0.0000 with 'Kết quả KHÁC đáp án!'. 0-byte files fail CreateFileMappingW with Win32 error 1006. Product decision: implement the documented byte-for-byte C5 contract and mark the historical DLL defect as intentionally not emulated; never call this exact DLL runtime parity while C5 fixture records differ from the defective DLL behavior.",
};

function sha256File(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex").toUpperCase();
}

export function runThemisOracleGate(modeOverride?: "verify" | "update-baseline") {
  const args = process.argv.slice(2);
  const isUpdateBaseline = modeOverride === "update-baseline" || args.includes("--update-baseline");
  const mode: "verify" | "update-baseline" = isUpdateBaseline ? "update-baseline" : "verify";

  console.log("=================================================================");
  console.log(`>>> [THEMIS ORACLE GATE] Live Windows x86 DLL Gate [MODE: ${mode.toUpperCase()}] <<<`);
  console.log("=================================================================\n");

  if (process.platform !== "win32") {
    console.log(`[oracle-gate] Platform is '${process.platform}'. Live Themis x86 DLL execution is Windows-only.`);
    console.log(`[oracle-gate] Skipping live DLL gate on non-Windows host.`);
    return;
  }

  const themisJudgersDir = process.env.THEMIS_JUDGERS_DIR || "C:\\Themis\\~judgers";
  if (!fs.existsSync(themisJudgersDir)) {
    console.log(`[oracle-gate] Themis judgers directory not found at: ${themisJudgersDir}`);
    console.log(`[oracle-gate] Live DLL execution skipped (Themis is not installed on this host).`);
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-oracle-gate-"));
  const ownershipMarker = path.join(tempRoot, "OWNERSHIP_MARKER.txt");
  fs.writeFileSync(ownershipMarker, `Owned by run-themis-oracle-gate.ts [${mode}]\n`);

  try {
    let harnessExe: string;
    if (process.env.THEMIS_ORACLE_HARNESS && fs.existsSync(process.env.THEMIS_ORACLE_HARNESS)) {
      harnessExe = process.env.THEMIS_ORACLE_HARNESS;
      console.log(`[oracle-gate] Using harness from THEMIS_ORACLE_HARNESS: ${harnessExe}`);
    } else {
      const repoHarness = path.join(projectRoot, "tools", "themis-oracle", "themis_oracle_harness.exe");
      if (fs.existsSync(repoHarness)) {
        harnessExe = repoHarness;
        console.log(`[oracle-gate] Using prebuilt repository harness: ${harnessExe}`);
      } else {
        // Build into owned tempRoot - do NOT compile into the repository during test
        const tempHarness = path.join(tempRoot, "themis_oracle_harness.exe");
        const gccPath = process.env.THEMIS_GCC || "C:\\Themis\\GCC\\bin\\gcc.exe";
        if (!fs.existsSync(gccPath)) {
          throw new Error(
            `[oracle-gate] Oracle harness binary missing and compiler not found at ${gccPath}.\n` +
            `Please build tools/themis-oracle/themis_oracle_harness.exe or provide THEMIS_ORACLE_HARNESS.`
          );
        }
        const cSource = path.join(projectRoot, "tools", "themis-oracle", "themis_oracle_harness.c");
        assert(fs.existsSync(cSource), `Harness source missing: ${cSource}`);
        console.log(`[oracle-gate] Compiling harness into owned temp directory: ${tempHarness}...`);
        const compile = spawnSync(
          gccPath,
          ["-O2", "-mconsole", cSource, "-lshell32", "-o", tempHarness],
          {
            cwd: tempRoot,
            env: { ...process.env, PATH: `C:\\Themis\\GCC\\bin;${process.env.PATH}` },
          },
        );
        if (compile.status !== 0) {
          throw new Error(`[oracle-gate] Failed to compile harness into temp dir: ${compile.stderr?.toString()}`);
        }
        harnessExe = tempHarness;
        console.log(`  ✔ Compiled harness in temp root: ${harnessExe}`);
      }
    }

    const corpusPath = path.join(projectRoot, "judgers", "fixtures", "themis-c1-c5-corpus.json");
    assert(fs.existsSync(corpusPath), `Corpus missing: ${corpusPath}`);
    const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));

    const baselinePath = path.join(projectRoot, "judgers", "fixtures", "themis-oracle-results.json");
    let baselineArtifact: ThemisOracleArtifactPayload | null = null;
    if (fs.existsSync(baselinePath)) {
      baselineArtifact = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    } else if (mode === "verify") {
      throw new Error(`[oracle-gate] Baseline artifact missing at ${baselinePath}. Cannot run --verify mode without baseline.`);
    }

    const baselineResultsById = new Map<string, ThemisOracleResultEntry>();
    if (baselineArtifact) {
      for (const entry of baselineArtifact.results) {
        baselineResultsById.set(entry.id, entry);
      }
    }

    // Verify live DLL hashes
    const dllHashes: Record<string, string> = {};
    for (const [id, dllName] of Object.entries(CHECKER_DLLS) as [("C1" | "C2" | "C3" | "C4" | "C5"), string][]) {
      const dllPath = path.join(themisJudgersDir, dllName);
      assert(fs.existsSync(dllPath), `Themis DLL missing: ${dllPath}`);
      dllHashes[id] = sha256File(dllPath);
      console.log(`  [DLL ${id}] ${dllName.padEnd(28)} SHA-256: ${dllHashes[id]}`);
    }

    if (mode === "verify") {
      assert(baselineArtifact, `[oracle-gate] Baseline artifact missing at ${baselinePath}. Cannot run --verify mode without baseline.`);
      assertOracleBaselineIntegrity(corpus, baselineArtifact, dllHashes);
      console.log(`  ✔ [Baseline Integrity] Verified 1-to-1 bijection, exact Base64 inputs, messages, statuses, and live DLL hashes match.\n`);
    }

    console.log(`\n[oracle-gate] Executing all ${corpus.fixtures.length} fixtures through Windows x86 harness...`);
    const liveResults: ThemisOracleResultEntry[] = [];
    let c1toC4Matches = 0;
    let c5Executed = 0;

    for (const fixture of corpus.fixtures) {
      // 1. Separate owned expected and actual directories per fixture
      const fixtureRoot = path.join(tempRoot, fixture.id);
      const workDir = path.join(fixtureRoot, "work");
      const ansDir = path.join(fixtureRoot, "ans");
      fs.mkdirSync(workDir, { recursive: true });
      fs.mkdirSync(ansDir, { recursive: true });

      const testFilename = "TEST.OUT";
      const actualBytes = Buffer.from(fixture.actualBase64, "base64");
      const expectedBytes = Buffer.from(fixture.expectedBase64, "base64");
      fs.writeFileSync(path.join(workDir, testFilename), actualBytes);
      fs.writeFileSync(path.join(ansDir, testFilename), expectedBytes);

      // 2. Invoke x86 harness in child process
      const dllPath = path.join(themisJudgersDir, CHECKER_DLLS[fixture.checker]);
      const run = spawnSync(
        harnessExe,
        [dllPath, workDir, ansDir, testFilename, "PROB"],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );

      // 3. Fail closed on process failure or crash
      if (run.error) {
        throw new Error(`[oracle-gate][${fixture.id}] Process spawn error: ${run.error.message}`);
      }
      if (run.signal !== null) {
        throw new Error(`[oracle-gate][${fixture.id}] Process terminated by signal: ${run.signal} (timed out or killed)`);
      }
      if (run.status !== 0) {
        throw new Error(`[oracle-gate][${fixture.id}] Process exited with non-zero status: ${run.status}.\nStdout: ${run.stdout}\nStderr: ${run.stderr}`);
      }

      let parsedScore: number | null = null;
      let parsedVerdict: "AC" | "WA" | null = null;
      let hexComment: string | null = null;

      const stdout = run.stdout || "";
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("SCORE:")) {
          parsedScore = parseFloat(trimmed.slice(6).trim());
        } else if (trimmed.startsWith("VERDICT:")) {
          const v = trimmed.slice(8).trim();
          if (v === "AC" || v === "WA") {
            parsedVerdict = v;
          }
        } else if (trimmed.startsWith("COMMENT_HEX:")) {
          hexComment = trimmed.slice(12).trim();
        }
      }

      // Fail-closed validation of parsed tokens
      assert(parsedScore !== null, `[oracle-gate][${fixture.id}] Score was not parsed from harness output.`);
      assert(Number.isFinite(parsedScore), `[oracle-gate][${fixture.id}] Score is not finite: ${parsedScore}`);
      assert(parsedScore >= 0 && parsedScore <= 1, `[oracle-gate][${fixture.id}] Score out of bounds [0, 1]: ${parsedScore}`);

      assert(parsedVerdict !== null, `[oracle-gate][${fixture.id}] Invalid or missing verdict token in harness output: "${stdout}"`);

      assert(hexComment !== null && hexComment.length > 0, `[oracle-gate][${fixture.id}] Hex comment missing or empty.`);
      assert(/^[0-9A-Fa-f]+$/.test(hexComment), `[oracle-gate][${fixture.id}] Hex comment contains invalid characters: "${hexComment}"`);
      assert.equal(hexComment.length % 2, 0, `[oracle-gate][${fixture.id}] Hex comment byte length is odd: ${hexComment.length}`);

      const decodedComment = Buffer.from(hexComment, "hex").toString("utf16le");
      assert(decodedComment.trim().length > 0, `[oracle-gate][${fixture.id}] Decoded comment from UTF-16LE is empty.`);

      const execution: ThemisOracleExecution = {
        invoked: true,
        exitCode: run.status,
        signal: run.signal,
        dll: CHECKER_DLLS[fixture.checker],
        dllSha256: dllHashes[fixture.checker],
        rawScore: parsedScore,
        rawComment: decodedComment,
        hexComment,
        liveDllVerdict: parsedVerdict,
      };

      const resultEntry: ThemisOracleResultEntry = {
        id: fixture.id,
        checker: fixture.checker,
        description: fixture.description,
        fixtureInputBytes: {
          expectedBase64: fixture.expectedBase64,
          actualBase64: fixture.actualBase64,
        },
        oracleExecution: execution,
        judgedesk: {
          verdict: fixture.expectedVerdict,
          message: fixture.expectedMessage,
        },
        parityStatus: fixture.checker === "C5" ? "INTENTIONALLY_NOT_EMULATED" : "VERIFIED_EXACT_MATCH",
        productDecision: fixture.checker === "C5" ? C5_PRODUCT_DECISION : undefined,
      };
      liveResults.push(resultEntry);

      if (fixture.checker === "C5") {
        c5Executed += 1;
        // Live assert against recorded defective-DLL baseline
        if (mode === "verify") {
          const baseline = baselineResultsById.get(fixture.id);
          assert(baseline, `[oracle-gate][${fixture.id}] Missing baseline entry for C5 fixture.`);
          assert.equal(
            parsedVerdict,
            baseline.oracleExecution.liveDllVerdict,
            `[oracle-gate][${fixture.id}] C5 live DLL verdict mismatch against baseline! Live=${parsedVerdict}, Baseline=${baseline.oracleExecution.liveDllVerdict}`,
          );
          assert.equal(
            parsedScore,
            baseline.oracleExecution.rawScore,
            `[oracle-gate][${fixture.id}] C5 live DLL score mismatch against baseline! Live=${parsedScore}, Baseline=${baseline.oracleExecution.rawScore}`,
          );
          assert.equal(
            hexComment,
            baseline.oracleExecution.hexComment,
            `[oracle-gate][${fixture.id}] C5 live DLL hex comment mismatch against baseline!`,
          );
        }
        console.log(
          `  [C5] ${fixture.id.padEnd(42)} -> DLL: ${parsedVerdict.padEnd(3)} (score=${parsedScore.toFixed(4)}) | Live asserted against defective DLL baseline [INTENTIONALLY_NOT_EMULATED]`,
        );
      } else {
        c1toC4Matches += 1;
        // C1-C4: Live DLL MUST match expected verdict
        assert.equal(
          parsedVerdict,
          fixture.expectedVerdict,
          `[oracle-gate][${fixture.id}] Live Themis DLL verdict mismatch! DLL=${parsedVerdict}, Expected=${fixture.expectedVerdict} (comment: ${decodedComment})`,
        );

        if (mode === "verify") {
          const baseline = baselineResultsById.get(fixture.id);
          assert(baseline, `[oracle-gate][${fixture.id}] Missing baseline entry for fixture.`);
          assert.equal(
            parsedVerdict,
            baseline.oracleExecution.liveDllVerdict,
            `[oracle-gate][${fixture.id}] Live Themis DLL verdict mismatch against baseline! Live=${parsedVerdict}, Baseline=${baseline.oracleExecution.liveDllVerdict}`,
          );
          assert.equal(
            parsedScore,
            baseline.oracleExecution.rawScore,
            `[oracle-gate][${fixture.id}] Live Themis DLL score mismatch against baseline! Live=${parsedScore}, Baseline=${baseline.oracleExecution.rawScore}`,
          );
          assert.equal(
            hexComment,
            baseline.oracleExecution.hexComment,
            `[oracle-gate][${fixture.id}] Live Themis DLL hex comment mismatch against baseline!`,
          );
        }

        console.log(
          `  [${fixture.checker}] ${fixture.id.padEnd(42)} -> DLL: ${parsedVerdict.padEnd(3)} | Comment: "${decodedComment}" ✔ MATCH`,
        );
      }
    }

    if (mode === "verify") {
      console.log("\n=================================================================");
      console.log(`>>> [ORACLE GATE VERIFY PASSED] Read-only verification succeeded! <<<`);
      console.log(`  ✔ All 57 C1-C4 fixtures matched live DLLs and baseline.`);
      console.log(`  ✔ All 10 C5 fixtures live-asserted against defective DLL baseline.`);
      console.log(`  ✔ No artifacts were modified in --verify mode.`);
      console.log("=================================================================\n");
      return;
    }

    // MODE === "update-baseline": Write artifacts atomically
    const oracleArtifactPayload: ThemisOracleArtifactPayload = {
      manifestVersion: "2.0.0",
      timestamp: new Date().toISOString(),
      platform: "win32-x86",
      dllHashes,
      harnessBuild: {
        compiler: "gcc (MinGW.org GCC-9.2.0-1) 9.2.0",
        flags: "-O2 -mconsole -lshell32",
        source: "tools/themis-oracle/themis_oracle_harness.c",
      },
      summary: {
        totalFixtures: liveResults.length,
        c1toC4ValidatedExactMatches: c1toC4Matches,
        c5ExecutedWithProductDecision: c5Executed,
      },
      c5ProductDecision: C5_PRODUCT_DECISION,
      results: liveResults,
    };

    const tempArtifact = path.join(path.dirname(baselinePath), `themis-oracle-results.tmp.${Date.now()}`);
    fs.writeFileSync(tempArtifact, JSON.stringify(oracleArtifactPayload, null, 2) + "\n", "utf8");
    fs.renameSync(tempArtifact, baselinePath);
    console.log(`\n✔ Atomically wrote Oracle results baseline to: ${baselinePath}`);

    // Atomically update themis-c1-c5-corpus.json with bound evidence
    const boundFixtures: CorpusFixture[] = corpus.fixtures.map((f) => {
      const or = liveResults.find((r) => r.id === f.id);
      const binding: ThemisOracleCorpusBinding = {
        invoked: or?.oracleExecution.invoked ?? false,
        exitCode: or?.oracleExecution.exitCode ?? null,
        rawScore: or?.oracleExecution.rawScore ?? null,
        rawComment: or?.oracleExecution.rawComment ?? null,
        hexComment: or?.oracleExecution.hexComment ?? null,
        liveDllVerdict: or?.oracleExecution.liveDllVerdict ?? null,
        parityStatus: or?.parityStatus ?? "UNCHECKED",
        productDecision: or?.productDecision ?? undefined,
      };
      return {
        ...f,
        themisOracle: binding,
      };
    });

    const updatedCorpus: Corpus = {
      ...corpus,
      fixturesCount: boundFixtures.length,
      fixtures: boundFixtures,
    };
    const tempCorpus = path.join(path.dirname(corpusPath), `themis-c1-c5-corpus.tmp.${Date.now()}`);
    fs.writeFileSync(tempCorpus, JSON.stringify(updatedCorpus, null, 2) + "\n", "utf8");
    fs.renameSync(tempCorpus, corpusPath);
    console.log(`✔ Atomically updated bound corpus artifact at: ${corpusPath}`);

    console.log("\n=================================================================");
    console.log(`>>> [BASELINE UPDATED] Generated fresh Oracle baseline & corpus! <<<`);
    console.log("=================================================================\n");
  } finally {
    if (fs.existsSync(ownershipMarker)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runThemisOracleGate();
}
