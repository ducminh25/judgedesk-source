import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDescriptorForHost } from "../toolchains/manifest.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { prepareManagedToolchainExecutable } from "./workspace.js";

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
