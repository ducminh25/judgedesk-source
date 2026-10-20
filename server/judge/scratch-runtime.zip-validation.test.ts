import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildIsolatedScratchLaunch,
  stageValidatedScratchProject,
} from "./scratch-runtime.js";
import type { ExecutorWorkspace } from "../executor/workspace.js";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/corpus/static",
);
const zipSignatures = {
  centralDirectory: Buffer.from([0x50, 0x4b, 0x01, 0x02]),
  endOfCentralDirectory: Buffer.from([0x50, 0x4b, 0x05, 0x06]),
};

const fixtures = [
  { directory: "scratch_ac", filename: "project.sb3" },
  { directory: "scratch_legacy_ac", filename: "project.sb2" },
] as const;

function createWorkspace(t: TestContext): { workspace: ExecutorWorkspace; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-wp03-scratch-zip-"));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("judgedesk-wp03-scratch-zip-"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const workspace: ExecutorWorkspace = {
    id: "scratch-zip-validation",
    path: root,
    relative(name) { return path.join(root, name); },
    stage(source, name) {
      const destination = path.join(root, name);
      fs.copyFileSync(source, destination);
      return destination;
    },
    stageDirectory() { throw new Error("Unexpected directory staging"); },
    dispose() { throw new Error("Unexpected workspace disposal"); },
  };
  return { workspace, root };
}

function zipOffsets(bytes: Buffer): { central: number; end: number; data: number } {
  const central = bytes.indexOf(zipSignatures.centralDirectory);
  const end = bytes.lastIndexOf(zipSignatures.endOfCentralDirectory);
  assert.ok(central > 0, "canonical fixture must include a central directory");
  assert.ok(end > central, "canonical fixture must include an EOCD record");
  assert.equal(bytes.readUInt16LE(8), 0, "fixture project.json must be stored without compression");
  const data = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  return { central, end, data };
}

function withStoredAsset(original: Buffer, asset: Buffer): { archive: Buffer; assetStart: number } {
  const { central, end } = zipOffsets(original);
  const name = Buffer.from("asset.bin");
  const crc = zlib.crc32(asset);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(10, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(asset.length, 18);
  local.writeUInt32LE(asset.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const directory = Buffer.alloc(46 + name.length);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(10, 6);
  directory.writeUInt32LE(crc, 16);
  directory.writeUInt32LE(asset.length, 20);
  directory.writeUInt32LE(asset.length, 24);
  directory.writeUInt16LE(name.length, 28);
  directory.writeUInt32LE(central, 42);
  name.copy(directory, 46);
  const oldDirectory = original.subarray(central, end);
  const trailer = Buffer.from(original.subarray(end));
  trailer.writeUInt16LE(2, 8);
  trailer.writeUInt16LE(2, 10);
  trailer.writeUInt32LE(oldDirectory.length + directory.length, 12);
  trailer.writeUInt32LE(central + local.length + asset.length, 16);
  return {
    archive: Buffer.concat([original.subarray(0, central), local, asset, oldDirectory, directory, trailer]),
    assetStart: central + local.length,
  };
}

for (const { directory, filename } of fixtures) {
  const canonicalPath = path.join(fixtureRoot, directory, filename);

  test(`${filename}: valid corpus archive stages its original bytes`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const staged = stageValidatedScratchProject(workspace, canonicalPath, filename);
    assert.equal(staged, path.join(root, filename));
    assert.deepEqual(fs.readFileSync(path.join(root, filename)), fs.readFileSync(canonicalPath));
  });

  test(`${filename}: accepts a complete data descriptor`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const original = fs.readFileSync(canonicalPath);
    const { central, end } = zipOffsets(original);
    const local = Buffer.from(original.subarray(0, central));
    const directory = Buffer.from(original.subarray(central, end));
    const trailer = Buffer.from(original.subarray(end));
    local.writeUInt16LE(local.readUInt16LE(6) | 8, 6);
    local.fill(0, 14, 26);
    directory.writeUInt16LE(directory.readUInt16LE(8) | 8, 8);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(directory.readUInt32LE(16), 4);
    descriptor.writeUInt32LE(directory.readUInt32LE(20), 8);
    descriptor.writeUInt32LE(directory.readUInt32LE(24), 12);
    trailer.writeUInt32LE(central + descriptor.length, 16);
    const archivePath = path.join(root, `complete-descriptor-${filename}`);
    fs.writeFileSync(archivePath, Buffer.concat([local, descriptor, directory, trailer]));
    const staged = stageValidatedScratchProject(workspace, archivePath, filename);
    assert.equal(staged, path.join(root, filename));
  });

  test(`${filename}: accepts a valid deflated project entry`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const original = fs.readFileSync(canonicalPath);
    const { central, end, data } = zipOffsets(original);
    const payload = zlib.deflateRawSync(original.subarray(data, central));
    const local = Buffer.from(original.subarray(0, data));
    const directory = Buffer.from(original.subarray(central, end));
    const trailer = Buffer.from(original.subarray(end));
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(payload.length, 20);
    trailer.writeUInt32LE(data + payload.length, 16);
    const archivePath = path.join(root, `deflated-${filename}`);
    fs.writeFileSync(archivePath, Buffer.concat([local, payload, directory, trailer]));
    const staged = stageValidatedScratchProject(workspace, archivePath, filename);
    assert.equal(staged, path.join(root, filename));
  });

  test(`${filename}: rejects archive without central directory`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const bytes = fs.readFileSync(canonicalPath);
    const { central } = zipOffsets(bytes);
    const malformedPath = path.join(root, `missing-central-${filename}`);
    fs.writeFileSync(malformedPath, bytes.subarray(0, central));
    assert.throws(
      () => stageValidatedScratchProject(workspace, malformedPath, filename),
      /SCRATCH_PROJECT_MALFORMED/,
    );
  });

  test(`${filename}: rejects archive without end-of-central-directory record`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const bytes = fs.readFileSync(canonicalPath);
    const { end } = zipOffsets(bytes);
    const malformedPath = path.join(root, `missing-eocd-${filename}`);
    fs.writeFileSync(malformedPath, bytes.subarray(0, end));
    assert.throws(
      () => stageValidatedScratchProject(workspace, malformedPath, filename),
      /SCRATCH_PROJECT_MALFORMED/,
    );
  });

  test(`${filename}: rejects mismatched central-directory CRC`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const bytes = Buffer.from(fs.readFileSync(canonicalPath));
    const { central } = zipOffsets(bytes);
    bytes[central + 16] ^= 0x01;
    const malformedPath = path.join(root, `bad-crc-${filename}`);
    fs.writeFileSync(malformedPath, bytes);
    assert.throws(
      () => stageValidatedScratchProject(workspace, malformedPath, filename),
      /SCRATCH_PROJECT_MALFORMED/,
    );
  });

  test(`${filename}: rejects a data-descriptor flag without a descriptor`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const bytes = Buffer.from(fs.readFileSync(canonicalPath));
    const { central } = zipOffsets(bytes);
    bytes.writeUInt16LE(bytes.readUInt16LE(6) | 8, 6);
    bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 8, central + 8);
    const malformedPath = path.join(root, `missing-descriptor-${filename}`);
    fs.writeFileSync(malformedPath, bytes);
    assert.throws(
      () => stageValidatedScratchProject(workspace, malformedPath, filename),
      /SCRATCH_PROJECT_MALFORMED/,
    );
  });

  test(`${filename}: rejects changed but parseable project data with stale CRC`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const bytes = Buffer.from(fs.readFileSync(canonicalPath));
    const { central, data } = zipOffsets(bytes);
    const marker = bytes.indexOf(Buffer.from("Stage"), data);
    assert.ok(marker >= data && marker < central, "fixture project.json must contain Stage");
    bytes[marker] = "s".charCodeAt(0);
    const malformedPath = path.join(root, `bad-data-${filename}`);
    fs.writeFileSync(malformedPath, bytes);
    assert.throws(
      () => stageValidatedScratchProject(workspace, malformedPath, filename),
      /SCRATCH_PROJECT_MALFORMED/,
    );
  });

  test(`${filename}: rejects a corrupted non-project asset`, async (t) => {
    const { workspace, root } = createWorkspace(t);
    const { archive, assetStart } = withStoredAsset(fs.readFileSync(canonicalPath), Buffer.from("costume bytes"));
    archive[assetStart] ^= 0x01;
    const malformedPath = path.join(root, `bad-asset-${filename}`);
    fs.writeFileSync(malformedPath, archive);
    assert.throws(
      () => stageValidatedScratchProject(workspace, malformedPath, filename),
      /SCRATCH_PROJECT_MALFORMED/,
    );
  });
}

test("Scratch launch uses a verified managed grant instead of resource-only local execution", () => {
  const toolchain = {
    packageId: "scratch-windows-x64",
    packageDigest: "a".repeat(64),
    componentId: "scratch.runtime",
  };
  const launch = buildIsolatedScratchLaunch("submission.sb3", {
    executableId: "toolchains/scratch/scratch-run.exe",
    executablePath: "C:\\executor\\toolchains\\scratch\\scratch-run.exe",
    root: "C:\\executor\\toolchains\\scratch",
    toolchain,
  });
  assert.deepEqual(launch.toolchain, toolchain);
  assert.equal("localToolchain" in launch, false);
  assert.equal(launch.environment.JUDGEDESK_SCRATCH_ISOLATED, "1");
});
