import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDescriptorForHost } from "../toolchains/manifest.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import {
  cloneRegularDirectory,
  inspectRegularDirectory,
  managedToolchainSourceRoot,
  prepareManagedToolchainExecutable,
} from "./workspace.js";

test("a catalog symlink resolves against its explicit managed package root", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-managed-symlink-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const versionedExecutable = path.join(bin, "python3.12");
  const catalogEntrypoint = path.join(bin, "python3");
  fs.mkdirSync(bin);
  fs.writeFileSync(versionedExecutable, "runtime");
  try {
    fs.symlinkSync("python3.12", catalogEntrypoint, "file");
  } catch {
    t.skip("creating file symlinks requires additional privileges");
    return;
  }

  assert.equal(
    managedToolchainSourceRoot(
      fs.realpathSync(catalogEntrypoint),
      "bin/python3",
      root,
    ),
    fs.realpathSync(root),
  );
  assert.throws(
    () =>
      managedToolchainSourceRoot(
        fs.realpathSync(catalogEntrypoint),
        "bin/python3",
      ),
    /TOOLCHAIN_NOT_SANDBOX_COMPATIBLE/,
  );
});

test("a built-in managed toolchain is referenced directly without an executor-cache copy", async (t) => {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), "python");
  if (!descriptor) {
    t.skip("no managed Python descriptor exists for this host");
    return;
  }
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-built-in-workspace-"),
  );
  const packageRoot = path.join(root, descriptor.id);
  const executablePath = path.join(
    packageRoot,
    ...descriptor.executableRelativePath.split("/"),
  );
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, "runtime");
  const entrypoint = descriptor.entrypoints.find(
    (candidate) => candidate.kind === "python",
  );
  assert.ok(entrypoint);
  fs.writeFileSync(
    path.join(packageRoot, ".judgedesk-package.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageId: descriptor.id,
      version: descriptor.version,
      archiveSha256: "a".repeat(64),
      entrypointComponentId: entrypoint.componentId,
      components: [{
        id: entrypoint.componentId,
        kind: "executable",
        relativePath: entrypoint.executableRelativePath,
        roles: ["submission-runtime", "checker-runtime"],
      }],
    }),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const resolved: ResolvedToolchain = {
    kind: "python",
    source: "managed",
    executablePath,
    version: descriptor.version,
    ready: true,
    packageOrigin: "built-in",
    packageRoot,
    packageDigest: "a".repeat(64),
    packageComponentId: entrypoint.componentId,
  };
  const prepared = await prepareManagedToolchainExecutable("python", resolved);

  assert.equal(prepared.root, fs.realpathSync(packageRoot));
  assert.equal(prepared.executablePath, fs.realpathSync(executablePath));
  assert.equal(
    prepared.executableId,
    `builtin-toolchains/${descriptor.id}/${descriptor.executableRelativePath}`,
  );
  assert.deepEqual(prepared.toolchain, {
    packageId: descriptor.id,
    packageDigest: "a".repeat(64),
    componentId: entrypoint.componentId,
  });
});

test("workspace directory clones are isolated copies and preserve empty directories", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-directory-clone-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  fs.mkdirSync(path.join(source, "nested", "empty"), { recursive: true });
  fs.writeFileSync(path.join(source, "nested", "cache.bin"), "original");

  inspectRegularDirectory(source, {
    maxFiles: 10,
    maxBytes: 1_024,
  });
  cloneRegularDirectory(source, destination);

  assert.equal(
    fs.readFileSync(path.join(destination, "nested", "cache.bin"), "utf8"),
    "original",
  );
  assert.equal(
    fs.statSync(path.join(destination, "nested", "empty")).isDirectory(),
    true,
  );
  fs.writeFileSync(path.join(destination, "nested", "cache.bin"), "changed");
  assert.equal(
    fs.readFileSync(path.join(source, "nested", "cache.bin"), "utf8"),
    "original",
  );
});

test("workspace directory cloning rejects symlinks without leaving a partial copy", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-directory-clone-link-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "target"), "target");
  try {
    fs.symlinkSync("target", path.join(source, "link"), "file");
  } catch {
    t.skip("creating file symlinks requires additional privileges");
    return;
  }

  assert.throws(
    () => {
      inspectRegularDirectory(source, {
        maxFiles: 10,
        maxBytes: 1_024,
      });
      cloneRegularDirectory(source, destination);
    },
    /rejects symbolic links/,
  );
  assert.equal(fs.existsSync(destination), false);
});
