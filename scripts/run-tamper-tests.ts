import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalManifestPath = path.join(repoRoot, "docs", "verification", "pure-rust-core", "corpus-manifest.json");
const originalCorpusRoot = path.join(repoRoot, "server", "test-fixtures", "corpus");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-test-owned-"));
fs.writeFileSync(path.join(tmpDir, "judgedesk-test-owned"), "MARKER\n");
const tmpManifestPath = path.join(tmpDir, "corpus-manifest.json");
const tmpCorpusRoot = path.join(tmpDir, "corpus");

function copyRecursiveSync(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, file), path.join(dest, file));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

copyRecursiveSync(originalCorpusRoot, tmpCorpusRoot);
fs.copyFileSync(originalManifestPath, tmpManifestPath);

const testCommand = "node scripts/run-all-tests.js --filter=corpus.test.ts";
const env = { ...process.env, CORPUS_ROOT_OVERRIDE: tmpCorpusRoot, CORPUS_MANIFEST_OVERRIDE: tmpManifestPath };

interface ExecError extends Error {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

function runTestExpectFail(reason: string, expectedPattern: RegExp): void {
  try {
    execSync(testCommand, { stdio: "pipe", env });
    console.error(`❌ Expected failure for: ${reason}, but it passed!`);
    process.exit(1);
  } catch (err: unknown) {
    const execErr = err as ExecError;
    const stdoutStr = execErr.stdout ? execErr.stdout.toString() : "";
    const stderrStr = execErr.stderr ? execErr.stderr.toString() : "";
    const output = stdoutStr + stderrStr;
    if (!expectedPattern.test(output)) {
      console.error(`❌ Failed for wrong reason on ${reason}. Expected pattern: ${expectedPattern}. Output was:\n${output}`);
      process.exit(1);
    }
    console.log(`✅ Verified failure for: ${reason}`);
  }
}

interface ManifestCase {
  id: string;
  languageProfileId: string;
  extension: string;
  expectedScore: { numerator: string; denominator: string; display: number };
  expectedMaxScore: { numerator: string; denominator: string; display: number };
  tests: { name: string; score: { numerator: string; denominator: string; display: number } }[];
  files: { path: string; size?: number; sha256?: string; expectedAbsence?: boolean }[];
  groupEffects?: {
    groupId: string;
    dependenciesMet: boolean;
    resolvedVerdict: string;
    score: { numerator: string; denominator: string; display: number };
  }[];
}

interface ManifestFile {
  version: number;
  cases: ManifestCase[];
  hackedProperty?: string;
}

try {
  const originalManifest = fs.readFileSync(tmpManifestPath, "utf8");

  // 1. Tampered file bytes (hash/size mismatch)
  const tamperedFile = path.join(tmpCorpusRoot, "static", "cpp_ac_stdio", "tests", "01.in");
  const originalFile = fs.readFileSync(tamperedFile);
  fs.writeFileSync(tamperedFile, Buffer.concat([originalFile, Buffer.from("tamper")]));
  runTestExpectFail("Tampered file bytes", /size|hash/i);
  fs.writeFileSync(tamperedFile, originalFile); // restore

  // 2. Missing file
  fs.renameSync(tamperedFile, tamperedFile + ".bak");
  runTestExpectFail("Missing file", /absent|missing|undeclared|exist/i);
  fs.renameSync(tamperedFile + ".bak", tamperedFile); // restore

  // 3. Orphan file
  const orphanFile = path.join(tmpCorpusRoot, "static", "cpp_ac_stdio", "orphan.txt");
  fs.writeFileSync(orphanFile, "orphan");
  runTestExpectFail("Orphan file", /undeclared/i);
  fs.unlinkSync(orphanFile); // restore

  // 4. Non-canonical case ordering
  const unorderedManifest = JSON.parse(originalManifest) as ManifestFile;
  unorderedManifest.cases.reverse();
  fs.writeFileSync(tmpManifestPath, JSON.stringify(unorderedManifest));
  runTestExpectFail("non-canonical-case-order", /deepStrictEqual|Cases must be sorted by ID/i);
  fs.writeFileSync(tmpManifestPath, originalManifest);

  // 5. Invalid rational value
  const invalidRationalManifest = JSON.parse(originalManifest) as ManifestFile;
  invalidRationalManifest.cases[0].expectedScore.denominator = "0";
  fs.writeFileSync(tmpManifestPath, JSON.stringify(invalidRationalManifest));
  runTestExpectFail("invalid-rational", /Invalid expectedScore|Invalid rational/i);
  fs.writeFileSync(tmpManifestPath, originalManifest);

  // 6. Schema additional property forbidden
  const addPropManifest = JSON.parse(originalManifest) as ManifestFile;
  addPropManifest.hackedProperty = "yes";
  fs.writeFileSync(tmpManifestPath, JSON.stringify(addPropManifest));
  runTestExpectFail("schema-additional-property", /Schema validation failed|must NOT have additional properties/i);
  fs.writeFileSync(tmpManifestPath, originalManifest);

  // 7. Non-release profile
  const forgedManifest = JSON.parse(originalManifest) as ManifestFile;
  forgedManifest.cases[0].languageProfileId = "go-126"; // Experimental profile not in release scope
  fs.writeFileSync(tmpManifestPath, JSON.stringify(forgedManifest));
  runTestExpectFail("non-release-profile", /Forged or non-release languageProfileId/i);
  fs.writeFileSync(tmpManifestPath, originalManifest);

  // 8. Profile-extension mismatch (e.g. .cpp case set to python-cpython312)
  const profileMismatchManifest = JSON.parse(originalManifest) as ManifestFile;
  profileMismatchManifest.cases[0].languageProfileId = "python-cpython312"; // case 0 has extension "cpp"
  fs.writeFileSync(tmpManifestPath, JSON.stringify(profileMismatchManifest));
  runTestExpectFail("profile-extension-mismatch", /does not support extension \.(c|cpp)/i);
  fs.writeFileSync(tmpManifestPath, originalManifest);

  // Descriptor mutations
  const descriptorManifest = JSON.parse(originalManifest) as ManifestFile;
  const descriptorCase = descriptorManifest.cases.find((c) => c.id === "edge_case_structure");
  if (descriptorCase) {
    const descriptorPath = path.join(tmpCorpusRoot, "generated", "edge_case_structure", "virtual-structure.json");
    const origDesc = fs.readFileSync(descriptorPath, "utf8");

    function writeDescriptor(contentStr: string): void {
      const descTmp = descriptorPath + ".tmp";
      fs.writeFileSync(descTmp, contentStr);
      fs.renameSync(descTmp, descriptorPath);

      const hash = crypto.createHash("sha256").update(contentStr).digest("hex");
      const m = JSON.parse(originalManifest) as ManifestFile;
      const targetCase = m.cases.find((c) => c.id === "edge_case_structure");
      if (!targetCase) throw new Error("edge_case_structure missing in manifest");
      const f = targetCase.files.find((file) => file.path === "virtual-structure.json");
      if (!f) throw new Error("virtual-structure.json missing in case files");
      f.size = Buffer.byteLength(contentStr);
      f.sha256 = hash;

      const manTmp = tmpManifestPath + ".tmp";
      fs.writeFileSync(manTmp, JSON.stringify(m));
      fs.renameSync(manTmp, tmpManifestPath);
    }

    // 9. Windows absolute descriptor path
    writeDescriptor(JSON.stringify({
      kind: "case_collision_and_long_path",
      virtualFiles: [{ path: "C:/absolute", content: "root" }, { path: "dummy2", content: "r" }]
    }));
    runTestExpectFail("windows-absolute-descriptor-path", /absolute path forbidden/i);

    // 10. Nested windows device path
    writeDescriptor(JSON.stringify({
      kind: "case_collision_and_long_path",
      virtualFiles: [{ path: "tests/CON", content: "root" }, { path: "dummy2", content: "r" }]
    }));
    runTestExpectFail("nested-windows-device-path", /Windows device name forbidden/i);

    // 11. Descriptor collision semantics stripped (two safe non-colliding files)
    writeDescriptor(JSON.stringify({
      kind: "case_collision_and_long_path",
      virtualFiles: [
        { path: "tests/safe1.in", content: "a" },
        { path: "tests/safe2.in", content: "b" },
        { path: "tests/" + "A".repeat(200) + ".in", content: "c" }
      ]
    }));
    runTestExpectFail("descriptor-collision-stripped", /Descriptor must contain case-colliding paths/i);

    // 12. Descriptor long-path semantic stripped (collision retained, long path removed)
    writeDescriptor(JSON.stringify({
      kind: "case_collision_and_long_path",
      virtualFiles: [
        { path: "tests/collision.in", content: "a" },
        { path: "tests/Collision.in", content: "b" }
      ]
    }));
    runTestExpectFail("descriptor-long-path-stripped", /Descriptor must contain long path/i);

    // 13. Descriptor missing declared kind
    writeDescriptor(JSON.stringify({
      virtualFiles: [
        { path: "tests/collision.in", content: "a" },
        { path: "tests/Collision.in", content: "b" },
        { path: "tests/" + "A".repeat(200) + ".in", content: "c" }
      ]
    }));
    runTestExpectFail("descriptor-missing-kind", /Descriptor must declare kind case_collision_and_long_path/i);

    fs.writeFileSync(descriptorPath, origDesc);
    fs.writeFileSync(tmpManifestPath, originalManifest);
  }

  // 14. Unreduced rational fraction / fraction-display disagreement
  const fractionDisagreementManifest = JSON.parse(originalManifest) as ManifestFile;
  fractionDisagreementManifest.cases[0].expectedScore.numerator = "2";
  fractionDisagreementManifest.cases[0].expectedScore.denominator = "2";
  fractionDisagreementManifest.cases[0].expectedScore.display = 1;
  fs.writeFileSync(tmpManifestPath, JSON.stringify(fractionDisagreementManifest));
  runTestExpectFail("fraction-display-disagreement", /Invalid expectedScore|Invalid rational/i);
  fs.writeFileSync(tmpManifestPath, originalManifest);

  // 15. Group dependenciesMet semantic mutation
  const groupDepManifest = JSON.parse(originalManifest) as ManifestFile;
  const depCase = groupDepManifest.cases.find((c) => c.id === "group_dependencies");
  if (depCase && depCase.groupEffects && depCase.groupEffects[1]) {
    depCase.groupEffects[1].dependenciesMet = true; // Was false in reality
    fs.writeFileSync(tmpManifestPath, JSON.stringify(groupDepManifest));
    runTestExpectFail("group-dependencies-met-mutation", /dependenciesMet mismatch/i);
    fs.writeFileSync(tmpManifestPath, originalManifest);
  }

  // 16. Group resolvedVerdict semantic mutation
  const groupVerdictManifest = JSON.parse(originalManifest) as ManifestFile;
  const compCase = groupVerdictManifest.cases.find((c) => c.id === "complete_group");
  if (compCase && compCase.groupEffects && compCase.groupEffects[0]) {
    compCase.groupEffects[0].resolvedVerdict = "AC"; // Was PARTIAL in reality
    fs.writeFileSync(tmpManifestPath, JSON.stringify(groupVerdictManifest));
    runTestExpectFail("group-resolved-verdict-mutation", /resolvedVerdict mismatch/i);
    fs.writeFileSync(tmpManifestPath, originalManifest);
  }

  // 17. Group exact rational score mutation
  const groupScoreManifest = JSON.parse(originalManifest) as ManifestFile;
  const pyCheckCase = groupScoreManifest.cases.find((c) => c.id === "python_custom_checker");
  if (pyCheckCase && pyCheckCase.groupEffects && pyCheckCase.groupEffects[0]) {
    pyCheckCase.groupEffects[0].score.numerator = "49"; // Was 50
    pyCheckCase.groupEffects[0].score.display = 49;
    fs.writeFileSync(tmpManifestPath, JSON.stringify(groupScoreManifest));
    runTestExpectFail("group-score-rational-mutation", /Group.*score numerator mismatch/i);
    fs.writeFileSync(tmpManifestPath, originalManifest);
  }

  // 18. Safe-integer overflow precision mutant (LOG-0045-F2 probe)
  const overflowRationalManifest = JSON.parse(originalManifest) as ManifestFile;
  overflowRationalManifest.cases[0].expectedScore.numerator = "9007199254740993";
  overflowRationalManifest.cases[0].expectedScore.denominator = "1";
  overflowRationalManifest.cases[0].expectedScore.display = 9007199254740992;
  fs.writeFileSync(tmpManifestPath, JSON.stringify(overflowRationalManifest));
  runTestExpectFail("safe-integer-overflow-mutation", /Invalid expectedScore|Invalid rational/i);
  fs.writeFileSync(tmpManifestPath, originalManifest);

  console.log("✅ All negative tamper tests passed successfully.");
} finally {
  const resolvedTmp = path.resolve(tmpDir);
  const resolvedOsTmp = path.resolve(os.tmpdir());
  const rel = path.relative(resolvedOsTmp, resolvedTmp);

  // Strict containment and ownership verification
  if (!resolvedTmp.startsWith(resolvedOsTmp) || !rel.startsWith("judgedesk-test-owned-")) {
    throw new Error(`Cleanup rejected: ${resolvedTmp} is not an owned temporary directory within ${resolvedOsTmp}`);
  }

  const markerFile = path.join(resolvedTmp, "judgedesk-test-owned");
  if (!fs.existsSync(markerFile) || fs.readFileSync(markerFile, "utf8") !== "MARKER\n") {
    throw new Error(`Cleanup rejected: marker file missing or invalid in ${resolvedTmp}`);
  }

  fs.rmSync(resolvedTmp, { recursive: true, force: true });

  if (fs.existsSync(resolvedTmp)) {
    throw new Error(`Cleanup failed: directory ${resolvedTmp} still exists after removal`);
  }
}
