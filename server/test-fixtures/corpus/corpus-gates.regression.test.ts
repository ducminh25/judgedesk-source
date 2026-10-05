import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverTestCases } from "../../judge/testcase-discovery.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const corpusTestPath = path.join(repoRoot, "server", "test-fixtures", "corpus", "corpus.test.ts");
const sourceCorpusRoot = path.join(repoRoot, "server", "test-fixtures", "corpus");
const sourceManifestPath = path.join(repoRoot, "docs", "verification", "pure-rust-core", "corpus-manifest.json");

interface OwnedCorpus {
  root: string;
  corpusRoot: string;
  manifestPath: string;
  profileRoot: string;
  localAppDataRoot: string;
  tempRoot: string;
}

function createOwnedCorpus(): OwnedCorpus {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-wp03-regression-"));
  fs.writeFileSync(path.join(root, "judgedesk-test-owned"), "owned WP0.3 regression root\n");
  const corpusRoot = path.join(root, "corpus");
  const manifestPath = path.join(root, "corpus-manifest.json");
  const profileRoot = path.join(root, "fake-profile");
  const localAppDataRoot = path.join(root, "local-appdata");
  const tempRoot = path.join(root, "temp");
  fs.cpSync(sourceCorpusRoot, corpusRoot, { recursive: true });
  fs.copyFileSync(sourceManifestPath, manifestPath);
  for (const dir of [profileRoot, localAppDataRoot, tempRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { root, corpusRoot, manifestPath, profileRoot, localAppDataRoot, tempRoot };
}

function removeOwnedCorpus(owned: OwnedCorpus): void {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(owned.root));
  assert.ok(relative.startsWith("judgedesk-wp03-regression-"), "Cleanup must stay inside the owned test root");
  assert.ok(!relative.includes(path.sep), "Cleanup must target only the owned test root");
  assert.ok(fs.existsSync(path.join(owned.root, "judgedesk-test-owned")), "Missing owned-root marker");
  fs.rmSync(owned.root, { recursive: true, force: true });
}

function runCorpusSuite(owned: OwnedCorpus, testPattern: string): { status: number | null; output: string } {
  const env = {
    ...process.env,
    CORPUS_ROOT_OVERRIDE: owned.corpusRoot,
    CORPUS_MANIFEST_OVERRIDE: owned.manifestPath,
    USERPROFILE: owned.profileRoot,
    HOME: owned.profileRoot,
    LOCALAPPDATA: owned.localAppDataRoot,
    APPDATA: path.join(owned.root, "roaming-appdata"),
    THEMIS_APP_DATA_DIR: path.join(owned.root, "themis-appdata"),
    TEMP: owned.tempRoot,
    TMP: owned.tempRoot,
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith("NODE_TEST_")) delete env[name];
  }
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--test", `--test-name-pattern=${testPattern}`, corpusTestPath,
  ], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

it("fails the corpus oracle gate when no release toolchain is provisioned", () => {
  const owned = createOwnedCorpus();
  try {
    const result = runCorpusSuite(owned, "must exist and contain a valid schema|provides bounded case-by-case Node-oracle execution");
    assert.notStrictEqual(
      result.status,
      0,
      `The corpus oracle gate passed without any provisioned toolchains:\n${result.output}`,
    );
  } finally {
    removeOwnedCorpus(owned);
  }
});

it("rejects a missing declared empty directory without creating it", () => {
  const owned = createOwnedCorpus();
  try {
    const manifest = JSON.parse(fs.readFileSync(owned.manifestPath, "utf8")) as {
      cases: Array<{ fixtureRoot: string; files: Array<{ path: string; emptyDirectory?: boolean }> }>;
    };
    const emptyDirectory = manifest.cases.flatMap((entry) =>
      entry.files.filter((file) => file.emptyDirectory).map((file) =>
        path.join(owned.corpusRoot, entry.fixtureRoot, file.path),
      ),
    );
    assert.strictEqual(emptyDirectory.length, 1, "Expected one declared empty-directory fixture");
    const target = emptyDirectory[0];
    assert.ok(target !== undefined);
    if (fs.existsSync(target)) {
      assert.deepStrictEqual(fs.readdirSync(target), [".judgedesk-empty"], "The declared directory must contain only its tracked structure marker");
      fs.unlinkSync(path.join(target, ".judgedesk-empty"));
      fs.rmdirSync(target);
    }
    assert.ok(!fs.existsSync(target), "Owned corpus must begin with its declared empty directory missing");

    const result = runCorpusSuite(owned, "must exist and contain a valid schema|all manifest files exist and match size/hash");
    assert.ok(!fs.existsSync(target), "Validation must not recreate a missing declared fixture directory");
    assert.notStrictEqual(result.status, 0, `The missing empty directory was accepted:\n${result.output}`);
    const generator = spawnSync(process.execPath, ["--import", "tsx", "scripts/generate-wp03-corpus.ts", "--check"], {
      cwd: repoRoot,
      env: { ...process.env, CORPUS_ROOT_OVERRIDE: owned.corpusRoot, CORPUS_MANIFEST_OVERRIDE: owned.manifestPath },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(generator.error);
    assert.notStrictEqual(generator.status, 0, `Generator check accepted a missing directory:\n${generator.stdout}\n${generator.stderr}`);
    assert.ok(!fs.existsSync(target), "Generator check must not repair the missing directory");
  } finally {
    removeOwnedCorpus(owned);
  }
});

it("the tracked empty-directory marker produces no discovered testcase", () => {
  const testsRoot = path.join(sourceCorpusRoot, "generated", "edge_case_structure", "tests");
  assert.deepStrictEqual(discoverTestCases(testsRoot), []);
  assert.deepStrictEqual(discoverTestCases(testsRoot, true), []);
});
