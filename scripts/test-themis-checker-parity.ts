import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStandardChecker } from "../server/judge/standard-checkers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

interface CorpusFixture {
  id: string;
  checker: "C1" | "C2" | "C3" | "C4" | "C5";
  description: string;
  expectedBase64: string;
  actualBase64: string;
  expectedVerdict: string;
  expectedMessage: string;
  themisOracle?: {
    verdict?: string;
    rawScore?: number | null;
    rawComment?: string | null;
    blocker?: string | null;
  };
}

interface Corpus {
  version: string;
  description?: string;
  fixturesCount?: number;
  fixtures: CorpusFixture[];
}

const CHECKER_SOURCES: Record<string, string> = {
  C1: "C1LinesWordsIgnoreCase.cpp",
  C2: "C2LinesWordsCase.cpp",
  C3: "C3WordsIgnoreCase.cpp",
  C4: "C4WordsCase.cpp",
  C5: "C5Binary.cpp",
};

function main() {
  console.log("=================================================================");
  console.log(">>> [STATIC PARITY GATE] Multi-Tier Node / Rust / C++ / Packaged Check <<<");
  console.log("=================================================================");

  const corpusPath = path.join(projectRoot, "judgers", "fixtures", "themis-c1-c5-corpus.json");
  assert(fs.existsSync(corpusPath), `Corpus missing: ${corpusPath}`);
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  console.log(`[parity-gate] Loaded corpus version ${corpus.version} with ${corpus.fixtures.length} fixtures.\n`);

  // --- Tier 1: Node.js Runtime Parity ---
  console.log("--- [Tier 1/4] Node.js Runtime Parity Gate ---");

  let nodePassed = 0;
  for (const fixture of corpus.fixtures) {
    const expected = Buffer.from(fixture.expectedBase64, "base64");
    const actual = Buffer.from(fixture.actualBase64, "base64");
    const result = runStandardChecker(fixture.checker, expected, actual);

    assert.equal(
      result.status,
      fixture.expectedVerdict,
      `[Node Tier][${fixture.id}] Status mismatch: expected ${fixture.expectedVerdict}, got ${result.status}`,
    );
    assert.equal(
      result.message,
      fixture.expectedMessage,
      `[Node Tier][${fixture.id}] Message mismatch: expected "${fixture.expectedMessage}", got "${result.message}"`,
    );
    nodePassed += 1;
  }
  console.log(`  ✔ Node.js runtime: ${nodePassed}/${corpus.fixtures.length} fixtures passed.\n`);

  // --- Tier 2: Rust Core Parity ---
  console.log("--- [Tier 2/4] Rust Core Parity Gate ---");
  const cargoPath = path.join(projectRoot, "crates", "judgedesk-core", "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    console.log(`  Running: cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test standard_checkers_test`);
    const cargoRun = spawnSync("cargo", ["test", "--locked", "--manifest-path", cargoPath, "--test", "standard_checkers_test"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (cargoRun.status !== 0) {
      console.error(cargoRun.stdout);
      console.error(cargoRun.stderr);
      throw new Error(`Rust core parity test failed with exit code ${cargoRun.status}`);
    }
    console.log(`  ✔ Rust core: all suite tests (including corpus) passed.\n`);
  } else {
    console.log(`  [Tier 2/4] Rust core Cargo.toml not found; skipping Rust tier.\n`);
  }

  // --- Tier 3: C++ Source Checkers Parity ---
  console.log("--- [Tier 3/4] C++ Compiled Sources Parity Gate ---");
  const tempRoot = path.join(os.tmpdir(), `judgedesk-themis-parity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempRoot, { recursive: true });
  const ownershipMarker = path.join(tempRoot, "OWNERSHIP_MARKER.txt");
  fs.writeFileSync(ownershipMarker, "Owned by test-themis-checker-parity.ts\n");

  try {
    const cxx = process.env.CXX || "g++";
    const checkCxx = spawnSync(cxx, ["--version"], { stdio: "ignore" });
    if (checkCxx.status !== 0) {
      throw new Error(
        `[Parity Gate Tier 3] Configured C++ compiler "${cxx}" is not available or failed execution.\n` +
        `Please install "${cxx}" or configure an explicit compiler via the CXX environment variable (e.g. CXX=g++ or CXX=clang++).`
      );
    }
    console.log(`  Configured C++ compiler: ${cxx}`);
    const binaries: Record<string, string> = {};
    for (const [id, srcFile] of Object.entries(CHECKER_SOURCES)) {
      const srcPath = path.join(projectRoot, "judgers", srcFile);
      const binName = process.platform === "win32" ? `${id}.exe` : id;
      const binPath = path.join(tempRoot, binName);
      execSync(`${cxx} -O3 -I"${path.join(projectRoot, "judgers")}" "${srcPath}" -o "${binPath}"`, {
        cwd: tempRoot,
        stdio: "ignore",
      });
      assert(fs.existsSync(binPath), `Compiled binary missing: ${binPath}`);
      binaries[id] = binPath;
    }

    let cppPassed = 0;
    const dummyInput = path.join(tempRoot, "dummy.inp");
    fs.writeFileSync(dummyInput, "");

    for (const fixture of corpus.fixtures) {
      const binPath = binaries[fixture.checker];
      assert(binPath, `No binary for checker ${fixture.checker}`);

      const answerPath = path.join(tempRoot, `${fixture.id}.ans`);
      const outputPath = path.join(tempRoot, `${fixture.id}.out`);
      fs.writeFileSync(answerPath, Buffer.from(fixture.expectedBase64, "base64"));
      fs.writeFileSync(outputPath, Buffer.from(fixture.actualBase64, "base64"));

      const run = spawnSync(binPath, [dummyInput, outputPath, answerPath], {
        encoding: "utf8",
        cwd: tempRoot,
      });

      let verdict = "FAIL";
      if (run.status === 0) verdict = "AC";
      else if (run.status === 1) verdict = "WA";
      else if (run.status === 2) verdict = "PE";

      const outputCombined = ((run.stdout || "") + "\n" + (run.stderr || "")).trim();
      let checkerMsg = "";
      for (const line of outputCombined.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("ok ")) {
          checkerMsg = trimmed.slice(3).trim();
          break;
        } else if (trimmed.startsWith("wrong answer ")) {
          checkerMsg = trimmed.slice(13).trim();
          break;
        } else if (trimmed.startsWith("wrong output format ")) {
          checkerMsg = trimmed.slice(20).trim();
          break;
        } else if (trimmed.startsWith("FAIL ")) {
          checkerMsg = trimmed.slice(5).trim();
          break;
        }
      }

      assert.equal(
        verdict,
        fixture.expectedVerdict,
        `[C++ Tier][${fixture.id}] Status mismatch: expected ${fixture.expectedVerdict}, got ${verdict} (msg: ${checkerMsg})`,
      );
      assert.equal(
        checkerMsg,
        fixture.expectedMessage,
        `[C++ Tier][${fixture.id}] Message mismatch: expected "${fixture.expectedMessage}", got "${checkerMsg}"`,
      );
      cppPassed += 1;
    }
    console.log(`  ✔ C++ compiled sources: ${cppPassed}/${corpus.fixtures.length} fixtures passed.\n`);
  } finally {
    if (fs.existsSync(ownershipMarker)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  // --- Tier 4/4: Windows Packaged Prebuilt Checkers Parity Gate ---
  if (process.platform === "win32") {
    console.log("--- [Tier 4/4] Windows Packaged Binaries Parity Gate (judgers/C1.exe - C5.exe) ---");
    const manifestPath = path.join(projectRoot, "judgers", "BUILD_MANIFEST.json");
    assert(fs.existsSync(manifestPath), `Build manifest missing: ${manifestPath}`);
    interface BuildManifestEntry {
      name: string;
      checker: "C1" | "C2" | "C3" | "C4" | "C5";
      source: string;
      sourceSha256: string;
      binarySha256: string;
      sizeBytes: number;
      reproduceCommand: string;
    }
    interface BuildManifest {
      manifestVersion: string;
      binaries: BuildManifestEntry[];
    }
    const manifest: BuildManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    // 1. Verify SHA-256 for all 5 source files and 5 prebuilt binaries against BUILD_MANIFEST.json
    for (const b of manifest.binaries) {
      const srcPath = path.join(projectRoot, "judgers", b.source);
      assert(fs.existsSync(srcPath), `Checker source missing: ${srcPath}`);
      const srcSha = crypto.createHash("sha256").update(fs.readFileSync(srcPath)).digest("hex").toUpperCase();
      assert.equal(
        srcSha,
        b.sourceSha256,
        `[BUILD_MANIFEST SHA-256 Mismatch] Source file ${b.source} hash changed! Expected ${b.sourceSha256}, got ${srcSha}`,
      );

      const binPath = path.join(projectRoot, "judgers", b.name);
      assert(fs.existsSync(binPath), `Checker prebuilt binary missing: ${binPath}`);
      const binSha = crypto.createHash("sha256").update(fs.readFileSync(binPath)).digest("hex").toUpperCase();
      assert.equal(
        binSha,
        b.binarySha256,
        `[BUILD_MANIFEST SHA-256 Mismatch] Binary file ${b.name} hash changed! Expected ${b.binarySha256}, got ${binSha}`,
      );
    }
    console.log(`  ✔ Verified BUILD_MANIFEST.json SHA-256 hashes for all 5 C++ sources and C1.exe–C5.exe binaries.`);

    // 2. Execute all 67 fixtures through packaged C1.exe - C5.exe
    const packagedTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-packaged-parity-"));
    const packagedOwnershipMarker = path.join(packagedTempRoot, "OWNERSHIP_MARKER.txt");
    fs.writeFileSync(packagedOwnershipMarker, "Owned by test-themis-checker-parity.ts packaged tier\n");

    try {
      const dummyInp = path.join(packagedTempRoot, "dummy.inp");
      fs.writeFileSync(dummyInp, "");

      let packagedPassed = 0;
      for (const fixture of corpus.fixtures) {
        const binPath = path.join(projectRoot, "judgers", `${fixture.checker}.exe`);
        const ansPath = path.join(packagedTempRoot, `${fixture.id}.ans`);
        const outPath = path.join(packagedTempRoot, `${fixture.id}.out`);

        fs.writeFileSync(ansPath, Buffer.from(fixture.expectedBase64, "base64"));
        fs.writeFileSync(outPath, Buffer.from(fixture.actualBase64, "base64"));

        const run = spawnSync(binPath, [dummyInp, outPath, ansPath], {
          encoding: "utf8",
          cwd: packagedTempRoot,
        });

        let verdict = "FAIL";
        if (run.status === 0) verdict = "AC";
        else if (run.status === 1) verdict = "WA";
        else if (run.status === 2) verdict = "PE";

        const outputCombined = ((run.stdout || "") + "\n" + (run.stderr || "")).trim();
        let checkerMsg = "";
        for (const line of outputCombined.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("ok ")) {
            checkerMsg = trimmed.slice(3).trim();
            break;
          } else if (trimmed.startsWith("wrong answer ")) {
            checkerMsg = trimmed.slice(13).trim();
            break;
          } else if (trimmed.startsWith("wrong output format ")) {
            checkerMsg = trimmed.slice(20).trim();
            break;
          } else if (trimmed.startsWith("FAIL ")) {
            checkerMsg = trimmed.slice(5).trim();
            break;
          }
        }

        assert.equal(
          verdict,
          fixture.expectedVerdict,
          `[Packaged Binaries Tier][${fixture.id}] Status mismatch: expected ${fixture.expectedVerdict}, got ${verdict} (msg: ${checkerMsg})`,
        );
        assert.equal(
          checkerMsg,
          fixture.expectedMessage,
          `[Packaged Binaries Tier][${fixture.id}] Message mismatch: expected "${fixture.expectedMessage}", got "${checkerMsg}"`,
        );
        packagedPassed += 1;
      }

      console.log(`  ✔ Windows packaged binaries: ${packagedPassed}/${corpus.fixtures.length} fixtures passed.\n`);
    } finally {
      if (fs.existsSync(packagedOwnershipMarker)) {
        fs.rmSync(packagedTempRoot, { recursive: true, force: true });
      }
    }
  } else {
    console.log("--- [Tier 4/4] Windows Packaged Binaries Parity Gate ---");
    console.log(`  Skipped on ${process.platform} (packaged Windows .exe check is Windows-only).\n`);
  }

  console.log("=================================================================");
  console.log(">>> [STATIC PARITY GATE PASSED] All multi-tier checks verified! <<<");
  console.log("  To execute the live Windows Themis DLL Oracle gate:");
  console.log("    npx tsx scripts/run-themis-oracle-gate.ts");
  console.log("=================================================================\n");

}

main();
