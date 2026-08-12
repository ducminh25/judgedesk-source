import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  assertToolchainPackageReceiptMatchesDescriptor,
  createInstalledToolchainPackageInspector,
  createToolchainPackageReceipt,
  inspectInstalledToolchainPackage,
  TOOLCHAIN_PACKAGE_RECEIPT,
  writeToolchainPackageReceipt,
} from "./package-store.js";
import type {
  ToolchainCatalogEntry,
  ToolchainDescriptor,
} from "./types.js";

const ENTRY: ToolchainCatalogEntry = {
  id: "test-runtime",
  provides: ["python"],
  entrypoints: [
    {
      kind: "python",
      componentId: "entrypoint",
      executableRelativePath:
        process.platform === "win32" ? "bin/runtime.exe" : "bin/runtime",
    },
  ],
  kind: "python",
  version: "1.2.3",
  platform: process.platform === "darwin" ? "darwin" : "win32",
  arch: process.arch === "arm64" ? "arm64" : "x64",
  archiveFormat: "zip",
  executableRelativePath:
    process.platform === "win32" ? "bin/runtime.exe" : "bin/runtime",
  licenseFiles: ["LICENSE.txt"],
};

const DESCRIPTOR: ToolchainDescriptor = {
  ...ENTRY,
  downloadUrl: "https://example.invalid/test-runtime.zip",
  sha256: "a".repeat(64),
  sizeBytes: 123,
};

test("request-scoped package inspection reuses only equivalent package identities", () => {
  let inspections = 0;
  const inspect = createInstalledToolchainPackageInspector(() => {
    inspections += 1;
    return { status: "not_installed" };
  });

  assert.equal(inspect(ENTRY).status, "not_installed");
  assert.equal(inspect(ENTRY, { kind: "python" }).status, "not_installed");
  assert.equal(inspections, 1);
  assert.equal(inspect({ ...ENTRY, version: "1.2.4" }).status, "not_installed");
  assert.equal(inspections, 2);
});

function temporaryStores(t: TestContext): {
  root: string;
  builtIn: string;
  downloaded: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-package-store-"));
  const builtIn = path.join(root, "built-in");
  const downloaded = path.join(root, "downloaded");
  fs.mkdirSync(builtIn);
  fs.mkdirSync(downloaded);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, builtIn, downloaded };
}

function createPackage(
  storeRoot: string,
  options: { receipt?: boolean; contents?: string } = {},
): string {
  const packageRoot = path.join(storeRoot, ENTRY.id);
  const executable = path.join(
    packageRoot,
    ...ENTRY.executableRelativePath.split("/"),
  );
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, options.contents ?? "runtime");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o700);
  if (options.receipt) writeToolchainPackageReceipt(packageRoot, DESCRIPTOR);
  return packageRoot;
}

test("a built-in pack requires a matching receipt and wins over a downloaded copy", (t) => {
  const stores = temporaryStores(t);
  const builtInRoot = createPackage(stores.builtIn, {
    receipt: true,
    contents: "built-in",
  });
  createPackage(stores.downloaded, { contents: "downloaded" });

  const state = inspectInstalledToolchainPackage(ENTRY, {
    builtInRoot: stores.builtIn,
    downloadedRoot: stores.downloaded,
  });
  assert.equal(state.status, "installed");
  if (state.status !== "installed") return;
  assert.equal(state.package.origin, "built-in");
  assert.equal(state.package.root, fs.realpathSync(builtInRoot));
  assert.equal(state.package.packageDigest, "a".repeat(64));
  assert.equal(state.package.integrity, "verified-receipt");
  assert.equal(state.package.uninstallable, false);
});

test("a Tauri Windows verbatim resource path resolves a built-in pack", {
  skip: process.platform !== "win32",
}, (t) => {
  const stores = temporaryStores(t);
  const packageRoot = createPackage(stores.builtIn, {
    receipt: true,
    contents: "built-in",
  });
  const verbatimBuiltInRoot = `\\\\?\\${stores.builtIn}`;

  const state = inspectInstalledToolchainPackage(ENTRY, {
    builtInRoot: verbatimBuiltInRoot,
    downloadedRoot: stores.downloaded,
  });

  assert.equal(state.status, "installed");
  if (state.status !== "installed") return;
  assert.equal(state.package.origin, "built-in");
  assert.equal(state.package.root, fs.realpathSync(packageRoot));
  assert.equal(state.package.integrity, "verified-receipt");
});

test("a corrupt built-in pack fails closed instead of falling back to downloaded", (t) => {
  const stores = temporaryStores(t);
  createPackage(stores.builtIn);
  createPackage(stores.downloaded);

  const state = inspectInstalledToolchainPackage(ENTRY, {
    builtInRoot: stores.builtIn,
    downloadedRoot: stores.downloaded,
  });
  assert.equal(state.status, "corrupt");
  if (state.status !== "corrupt") return;
  assert.equal(state.origin, "built-in");
  assert.match(state.diagnostic, /receipt is missing/i);
});

test("an existing downloaded pack without a receipt remains a legacy-compatible install", (t) => {
  const stores = temporaryStores(t);
  createPackage(stores.downloaded);

  const state = inspectInstalledToolchainPackage(ENTRY, {
    builtInRoot: stores.builtIn,
    downloadedRoot: stores.downloaded,
  });
  assert.equal(state.status, "installed");
  if (state.status !== "installed") return;
  assert.equal(state.package.origin, "downloaded");
  assert.equal(state.package.integrity, "legacy-entrypoint");
  assert.equal(state.package.uninstallable, true);
  assert.equal(state.package.packageDigest, undefined);
});

test("package receipts are deterministic and cannot overwrite archive content", (t) => {
  const stores = temporaryStores(t);
  const packageRoot = createPackage(stores.downloaded);
  writeToolchainPackageReceipt(packageRoot, DESCRIPTOR);
  const first = fs.readFileSync(
    path.join(packageRoot, TOOLCHAIN_PACKAGE_RECEIPT),
    "utf8",
  );
  assert.deepEqual(JSON.parse(first), {
    schemaVersion: 1,
    packageId: ENTRY.id,
    version: ENTRY.version,
    archiveSha256: "a".repeat(64),
    entrypointComponentId: "entrypoint",
    components: [
      {
        id: "entrypoint",
        kind: "executable",
        relativePath: ENTRY.executableRelativePath,
        roles: ["submission-runtime", "checker-runtime"],
      },
    ],
  });
  assert.throws(
    () => writeToolchainPackageReceipt(packageRoot, DESCRIPTOR),
    /EEXIST/,
  );
});

test("production receipt trust pins digest, components, paths, and roles", () => {
  const receipt = createToolchainPackageReceipt(DESCRIPTOR);
  assert.doesNotThrow(() =>
    assertToolchainPackageReceiptMatchesDescriptor(receipt, DESCRIPTOR)
  );
  assert.throws(
    () =>
      assertToolchainPackageReceiptMatchesDescriptor(
        {
          ...receipt,
          components: receipt.components.map((component) => ({
            ...component,
            roles: ["compiler"],
          })),
        },
        DESCRIPTOR,
      ),
    /bundled signed manifest/i,
  );
  assert.throws(
    () =>
      assertToolchainPackageReceiptMatchesDescriptor(
        { ...receipt, archiveSha256: "b".repeat(64) },
        DESCRIPTOR,
      ),
    /bundled signed manifest/i,
  );
});

test("a signed support-root component may explicitly grant the package root", (t) => {
  const stores = temporaryStores(t);
  const packageRoot = createPackage(stores.builtIn);
  const descriptor: ToolchainDescriptor = {
    ...DESCRIPTOR,
    entrypointComponentId: "runtime",
    components: [
      {
        id: "runtime",
        kind: "executable",
        relativePath: ENTRY.executableRelativePath,
        roles: ["submission-runtime", "checker-runtime"],
      },
      {
        id: "runtime-root",
        kind: "support-root",
        relativePath: ".",
        roles: ["submission-runtime", "checker-runtime"],
      },
    ],
  };
  writeToolchainPackageReceipt(packageRoot, descriptor);

  const state = inspectInstalledToolchainPackage({
    ...ENTRY,
    entrypoints: [{
      ...ENTRY.entrypoints[0],
      componentId: "runtime",
    }],
  }, {
    builtInRoot: stores.builtIn,
    downloadedRoot: stores.downloaded,
  });
  assert.equal(state.status, "installed");
  if (state.status !== "installed") return;
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, TOOLCHAIN_PACKAGE_RECEIPT),
      "utf8",
    ),
  );
  assert.equal(receipt.components[1].relativePath, ".");
});

test("receipt and executable traversal are rejected", (t) => {
  const stores = temporaryStores(t);
  const packageRoot = createPackage(stores.builtIn);
  fs.writeFileSync(
    path.join(packageRoot, TOOLCHAIN_PACKAGE_RECEIPT),
    JSON.stringify({
      schemaVersion: 1,
      packageId: ENTRY.id,
      version: ENTRY.version,
      archiveSha256: "a".repeat(64),
      entrypointComponentId: "entrypoint",
      components: [
        {
          id: "entrypoint",
          kind: "executable",
          relativePath: "../outside",
          roles: ["submission-runtime"],
        },
      ],
    }),
  );
  const state = inspectInstalledToolchainPackage(ENTRY, {
    builtInRoot: stores.builtIn,
    downloadedRoot: stores.downloaded,
  });
  assert.equal(state.status, "corrupt");
  if (state.status === "corrupt") {
    assert.match(state.diagnostic, /safe relative path/i);
  }
});
