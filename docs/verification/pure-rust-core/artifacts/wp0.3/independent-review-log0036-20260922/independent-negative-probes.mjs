import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../../..");
const sourceManifest = path.join(
  repositoryRoot,
  "docs",
  "verification",
  "pure-rust-core",
  "corpus-manifest.json",
);
const sourceCorpus = path.join(repositoryRoot, "server", "test-fixtures", "corpus");
const outputPath = path.join(import.meta.dirname, "negative-probes.json");
const rootPrefix = "judgedesk-wp03-review-";
const ownerToken = crypto.randomUUID();
const results = [];

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeOwnedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), rootPrefix));
  writeJson(path.join(root, ".owner.json"), { ownerToken, purpose: "WP0.3 independent negative probe" });
  return root;
}

function removeOwnedRoot(root) {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedTemp = fs.realpathSync(os.tmpdir());
  const relative = path.relative(resolvedTemp, resolvedRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing cleanup outside temp root: ${resolvedRoot}`);
  }
  if (!path.basename(resolvedRoot).startsWith(rootPrefix)) {
    throw new Error(`Refusing cleanup without expected prefix: ${resolvedRoot}`);
  }
  const marker = JSON.parse(fs.readFileSync(path.join(resolvedRoot, ".owner.json"), "utf8"));
  if (marker.ownerToken !== ownerToken) {
    throw new Error(`Refusing cleanup without exact ownership marker: ${resolvedRoot}`);
  }
  fs.rmSync(resolvedRoot, { recursive: true });
  if (fs.existsSync(resolvedRoot)) throw new Error(`Cleanup left root behind: ${resolvedRoot}`);
}

function updateDescriptorIntegrity(manifest, corpusRoot, virtualFiles) {
  const corpusCase = manifest.cases.find((candidate) => candidate.id === "edge_case_structure");
  const descriptor = corpusCase.files.find((file) => file.role === "descriptor");
  const descriptorPath = path.join(corpusRoot, corpusCase.fixtureRoot, descriptor.path);
  const bytes = Buffer.from(`${JSON.stringify({ virtualFiles })}\n`, "utf8");
  fs.writeFileSync(descriptorPath, bytes);
  descriptor.size = bytes.length;
  descriptor.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
}

function runProbe(name, expectedPattern, mutate) {
  const root = makeOwnedRoot();
  const manifestPath = path.join(root, "corpus-manifest.json");
  const corpusRoot = path.join(root, "corpus");
  let cleanupSucceeded = false;
  try {
    fs.cpSync(sourceCorpus, corpusRoot, { recursive: true, errorOnExist: true });
    fs.copyFileSync(sourceManifest, manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    mutate({ manifest, manifestPath, corpusRoot });
    if (mutate.writesManifest !== false) writeJson(manifestPath, manifest);

    const child = spawnSync(
      process.execPath,
      ["scripts/run-all-tests.js", "--filter=corpus.test.ts"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CORPUS_MANIFEST_OVERRIDE: manifestPath,
          CORPUS_ROOT_OVERRIDE: corpusRoot,
        },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const combined = `${child.stdout || ""}\n${child.stderr || ""}`;
    results.push({
      name,
      exitCode: child.status,
      signal: child.signal,
      timedOut: child.error?.code === "ETIMEDOUT",
      rejected: child.status !== 0,
      expectedReasonMatched: expectedPattern ? expectedPattern.test(combined) : null,
      outputTail: combined.trim().split(/\r?\n/).slice(-12),
    });
  } finally {
    removeOwnedRoot(root);
    cleanupSucceeded = true;
    const result = results.at(-1);
    if (result?.name === name) result.cleanupSucceeded = cleanupSucceeded;
  }
}

runProbe("declared-byte-change", /SHA256 mismatch|File size mismatch/, ({ corpusRoot }) => {
  fs.appendFileSync(path.join(corpusRoot, "static", "cpp_ac_stdio", "tests", "01.in"), "X");
});

runProbe("referenced-file-delete", /is missing/, ({ corpusRoot }) => {
  fs.unlinkSync(path.join(corpusRoot, "static", "cpp_ac_stdio", "tests", "01.in"));
});

runProbe("undeclared-file-add", /Undeclared file found/, ({ corpusRoot }) => {
  fs.writeFileSync(path.join(corpusRoot, "static", "cpp_ac_stdio", "orphan.txt"), "orphan");
});

runProbe("duplicate-case-id", /Duplicate ID found/, ({ manifest }) => {
  manifest.cases[1].id = manifest.cases[0].id;
});

runProbe("required-coverage-delete", /Missing custom checker coverage/, ({ manifest }) => {
  for (const corpusCase of manifest.cases) {
    corpusCase.tags = corpusCase.tags.filter((tag) => tag !== "custom_checker");
  }
});

runProbe("invalid-rational", /Invalid expectedScore/, ({ manifest }) => {
  manifest.cases[0].expectedScore = { numerator: "not-an-integer", denominator: "0", display: 0 };
});

runProbe("fixture-root-traversal", /Directory traversal in fixtureRoot/, ({ manifest }) => {
  manifest.cases[0].fixtureRoot = "../escape";
});

runProbe("declared-size-hash-mismatch", /File size mismatch|SHA256 mismatch/, ({ manifest }) => {
  const file = manifest.cases[0].files.find((candidate) => candidate.size !== undefined);
  file.size += 1;
  file.sha256 = "0".repeat(64);
});

runProbe("non-release-profile", /Forged languageProfileId/, ({ manifest }) => {
  manifest.cases[0].languageProfileId = "go-126";
});

runProbe("non-canonical-case-order", /Cases must be sorted by ID/, ({ manifest }) => {
  [manifest.cases[0], manifest.cases[1]] = [manifest.cases[1], manifest.cases[0]];
});

runProbe("collision-semantics-stripped", /collision|Descriptor cannot be empty|semantics/i, ({ manifest, corpusRoot }) => {
  updateDescriptorIntegrity(manifest, corpusRoot, [{ path: "tests/only.in", content: "safe" }]);
});

runProbe("windows-absolute-descriptor-path", /absolute path forbidden/i, ({ manifest, corpusRoot }) => {
  updateDescriptorIntegrity(manifest, corpusRoot, [{ path: "C:/absolute", content: "unsafe" }]);
});

runProbe("nested-windows-device-path", /device name forbidden/i, ({ manifest, corpusRoot }) => {
  updateDescriptorIntegrity(manifest, corpusRoot, [{ path: "tests/CON", content: "unsafe" }]);
});

runProbe("schema-additional-property", /additional|schema/i, ({ manifest }) => {
  manifest.unexpected = true;
});

writeJson(outputPath, {
  schemaVersion: 1,
  ownerToken,
  repositoryRoot,
  completedAt: new Date().toISOString(),
  results,
  residualOwnedRoots: fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(rootPrefix)),
});

for (const result of results) {
  console.log(`${result.name}: exit=${result.exitCode} rejected=${result.rejected} reasonMatched=${result.expectedReasonMatched} cleanup=${result.cleanupSucceeded}`);
}
