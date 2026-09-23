import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../../..");
const corpusRoot = path.join(repositoryRoot, "server", "test-fixtures", "corpus");
const manifestPath = path.join(repositoryRoot, "docs", "verification", "pure-rust-core", "corpus-manifest.json");
const schemaPath = path.join(repositoryRoot, "docs", "verification", "pure-rust-core", "corpus-manifest.schema.json");
const outputPath = path.join(import.meta.dirname, "inventory.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function walk(root, current = root, rows = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      rows.push({ path: relative, type: "directory", size: 0, sha256: "-" });
      walk(root, absolute, rows);
    } else {
      const bytes = fs.readFileSync(absolute);
      rows.push({ path: relative, type: "file", size: bytes.length, sha256: sha256(bytes) });
    }
  }
  return rows;
}

const rows = walk(corpusRoot).sort((a, b) => a.path.localeCompare(b.path));
const aggregateText = rows.map((row) => `${row.path}\t${row.type}\t${row.size}\t${row.sha256}`).join("\n") + "\n";
const declared = new Map();
let regularEntries = 0;
let descriptorEntries = 0;
let emptyDirectoryEntries = 0;
let expectedAbsenceEntries = 0;
let declaredBytes = 0;
const mismatches = [];

for (const corpusCase of manifest.cases) {
  for (const file of corpusCase.files) {
    const key = `${corpusCase.fixtureRoot}/${file.path}`;
    declared.set(key, file);
    if (file.role === "descriptor") descriptorEntries += 1;
    if (file.emptyDirectory) {
      emptyDirectoryEntries += 1;
      continue;
    }
    if (file.expectedAbsence) {
      expectedAbsenceEntries += 1;
      continue;
    }
    regularEntries += 1;
    declaredBytes += file.size;
    const absolute = path.join(corpusRoot, corpusCase.fixtureRoot, file.path);
    if (!fs.existsSync(absolute)) {
      mismatches.push({ key, problem: "missing" });
      continue;
    }
    const bytes = fs.readFileSync(absolute);
    const actualHash = sha256(bytes);
    if (bytes.length !== file.size || actualHash !== file.sha256.toUpperCase()) {
      mismatches.push({ key, problem: "integrity", expectedSize: file.size, actualSize: bytes.length, expectedHash: file.sha256, actualHash });
    }
  }
}

const physicalFixtureFiles = rows.filter((row) => row.type === "file" && row.path !== "corpus.test.ts");
const orphanFixtureFiles = physicalFixtureFiles.filter((row) => !declared.has(row.path)).map((row) => row.path);
const allExtensions = [...new Set(manifest.cases.map((corpusCase) => `.${corpusCase.extension}`))].sort();
const allTags = [...new Set(manifest.cases.flatMap((corpusCase) => corpusCase.tags))].sort();
const output = {
  schemaVersion: 1,
  cases: manifest.cases.length,
  physicalFilesIncludingValidator: rows.filter((row) => row.type === "file").length,
  physicalFixtureFiles: physicalFixtureFiles.length,
  physicalDirectories: rows.filter((row) => row.type === "directory").length,
  physicalBytesIncludingValidator: rows.filter((row) => row.type === "file").reduce((sum, row) => sum + row.size, 0),
  physicalFixtureBytes: physicalFixtureFiles.reduce((sum, row) => sum + row.size, 0),
  declaredEntries: [...declared].length,
  regularEntries,
  descriptorEntries,
  emptyDirectoryEntries,
  expectedAbsenceEntries,
  declaredBytes,
  uniqueCoverageTags: allTags.length,
  tags: allTags,
  extensions: allExtensions,
  manifestSha256: sha256(fs.readFileSync(manifestPath)),
  schemaSha256: sha256(fs.readFileSync(schemaPath)),
  aggregateCorpusSha256: sha256(Buffer.from(aggregateText, "utf8")),
  mismatches,
  orphanFixtureFiles,
};

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify(output, null, 2));
