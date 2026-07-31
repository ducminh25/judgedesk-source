import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalizeManifestPayload, TOOLCHAIN_RELEASE_BLUEPRINTS } from "./manifest.js";
import { TOOLCHAIN_PACKAGE_RECEIPT } from "./package-store.js";
import { prepareDistributionResources } from "./distribution-builder.js";
import { listCurrentReleaseManagedPackageIds } from "./release-scope.js";
import type {
  ToolchainManifestV2Document,
  ToolchainManifestV2Package,
  ToolchainManifestV2Payload,
} from "./types.js";

const TEST_KEY_ID = "distribution-test-key";

function testPaths(t: TestContext): { input: string; output: string } {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-dist-input-"));
  const output = path.join(
    process.cwd(),
    "build",
    `distribution-test-${crypto.randomUUID()}`,
  );
  t.after(() => {
    fs.rmSync(input, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  });
  return { input, output };
}

function fixture(packageId: string): {
  archive: Buffer;
  files: Readonly<Record<string, string>>;
  package: ToolchainManifestV2Package;
} {
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[packageId];
  assert.ok(blueprint, `missing blueprint for ${packageId}`);
  const entrypoint = blueprint.entrypoints.find(
    (candidate) =>
      candidate.componentId === blueprint.entrypointComponentId,
  );
  assert.ok(entrypoint, `missing entrypoint for ${packageId}`);
  const { archiveFilename: _archiveFilename, ...signedBlueprint } = blueprint;
  const files: Record<string, string> = {
    [entrypoint.executableRelativePath]: `runtime:${packageId}`,
    "SOURCE-PROVENANCE.json": `provenance:${packageId}`,
    [blueprint.license.sbomPath]: JSON.stringify({
      spdxVersion: "SPDX-2.3",
      name: packageId,
    }),
  };
  for (const relativePath of [
    ...blueprint.license.licenseFiles,
    ...blueprint.license.noticeFiles,
  ]) {
    files[relativePath] = `metadata:${packageId}:${relativePath}`;
  }
  const archive = Buffer.from(`fake signed archive:${packageId}`);
  return {
    archive,
    files,
    package: {
      ...signedBlueprint,
      downloadUrl: "https://example.invalid/python.zip",
      sha256: crypto.createHash("sha256").update(archive).digest("hex"),
      sizeBytes: archive.byteLength,
      installedSizeBytes: Object.values(files).reduce(
        (total, value) => total + Buffer.byteLength(value),
        0,
      ),
    },
  };
}

function writeSignedManifest(
  inputRoot: string,
  packageEntries: readonly ToolchainManifestV2Package[],
): string {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const payload: ToolchainManifestV2Payload = {
    generatedAt: "2026-07-30T00:00:00.000Z",
    packages: [...packageEntries],
  };
  const document: ToolchainManifestV2Document = {
    schemaVersion: 2,
    signed: payload,
    signature: {
      algorithm: "ed25519",
      keyId: TEST_KEY_ID,
      value: crypto.sign(
        null,
        Buffer.from(canonicalizeManifestPayload(payload), "utf8"),
        privateKey,
      ).toString("base64"),
    },
  };
  fs.writeFileSync(
    path.join(inputRoot, "toolchains-manifest.json"),
    JSON.stringify(document),
  );
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

test("Full materializes only signed host packs and Core carries only the catalog", async (t) => {
  const { input, output } = testPaths(t);
  const data = listCurrentReleaseManagedPackageIds("win32", "x64")
    .map((packageId) => fixture(packageId));
  for (const entry of data) {
    const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[entry.package.id];
    fs.writeFileSync(path.join(input, blueprint.archiveFilename), entry.archive);
  }
  const publicKey = writeSignedManifest(
    input,
    data.map((entry) => entry.package),
  );
  const extractArchive = (
    archivePath: string,
    destination: string,
  ): void => {
    const entry = data.find((candidate) =>
      TOOLCHAIN_RELEASE_BLUEPRINTS[candidate.package.id].archiveFilename
        === path.basename(archivePath)
    );
    assert.ok(entry, `unexpected archive ${archivePath}`);
    fs.mkdirSync(destination, { recursive: true });
    for (const [relativePath, contents] of Object.entries(entry.files)) {
      const filePath = path.join(destination, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
    }
  };

  const full = await prepareDistributionResources({
    variant: "full",
    inputRoot: input,
    outputRoot: output,
    platform: "win32",
    arch: "x64",
    trustedPublicKeys: { [TEST_KEY_ID]: publicKey },
    extractArchive,
    verifyExecutable: () => {},
  });
  assert.deepEqual(
    full.packages.map((entry) => entry.id),
    data.map((entry) => entry.package.id).sort(),
  );
  for (const entry of data) {
    assert.equal(
      fs.existsSync(
        path.join(
          output,
          "toolchains",
          entry.package.id,
          TOOLCHAIN_PACKAGE_RECEIPT,
        ),
      ),
      true,
    );
  }

  const core = await prepareDistributionResources({
    variant: "core",
    inputRoot: input,
    outputRoot: output,
    platform: "win32",
    arch: "x64",
    trustedPublicKeys: { [TEST_KEY_ID]: publicKey },
    extractArchive,
    verifyExecutable: () => {},
  });
  assert.deepEqual(core.packages, []);
  assert.equal(fs.existsSync(path.join(output, "toolchains")), false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(output, "judgedesk-distribution.json"), "utf8"),
    ).distribution,
    "core",
  );
});

test("Full fails closed when the signed catalog omits a release package", async (t) => {
  const { input, output } = testPaths(t);
  const data = listCurrentReleaseManagedPackageIds("win32", "x64")
    .slice(1)
    .map((packageId) => fixture(packageId));
  const publicKey = writeSignedManifest(
    input,
    data.map((entry) => entry.package),
  );

  await assert.rejects(
    prepareDistributionResources({
      variant: "full",
      inputRoot: input,
      outputRoot: output,
      platform: "win32",
      arch: "x64",
      trustedPublicKeys: { [TEST_KEY_ID]: publicKey },
      extractArchive: () => {
        throw new Error("must not extract an incomplete distribution");
      },
      verifyExecutable: () => {},
    }),
    /complete current release package set/,
  );
});

test("a failed Full rebuild preserves the previously committed resources", async (t) => {
  const { input, output } = testPaths(t);
  const data = listCurrentReleaseManagedPackageIds("win32", "x64")
    .map((packageId) => fixture(packageId));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "sentinel.txt"), "previous");
  const tamperedId = data
    .map((entry) => entry.package.id)
    .sort()[0];
  for (const entry of data) {
    const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[entry.package.id];
    fs.writeFileSync(
      path.join(input, blueprint.archiveFilename),
      entry.package.id === tamperedId
        ? Buffer.from("tampered archive")
        : entry.archive,
    );
  }
  const publicKey = writeSignedManifest(
    input,
    data.map((entry) => entry.package),
  );

  await assert.rejects(
    prepareDistributionResources({
      variant: "full",
      inputRoot: input,
      outputRoot: output,
      platform: "win32",
      arch: "x64",
      trustedPublicKeys: { [TEST_KEY_ID]: publicKey },
      extractArchive: () => {
        throw new Error("must not extract");
      },
      verifyExecutable: () => {},
    }),
    /invalid archive size|SHA-256 verification/,
  );
  assert.equal(
    fs.readFileSync(path.join(output, "sentinel.txt"), "utf8"),
    "previous",
  );
});
