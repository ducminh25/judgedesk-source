import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalizeManifestPayload, TOOLCHAIN_RELEASE_BLUEPRINTS } from "./manifest.js";
import { TOOLCHAIN_PACKAGE_RECEIPT } from "./package-store.js";
import { prepareDistributionResources } from "./distribution-builder.js";
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

function fixture(): {
  archive: Buffer;
  files: Readonly<Record<string, string>>;
  package: ToolchainManifestV2Package;
} {
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS["python-windows-x64"];
  const { archiveFilename: _archiveFilename, ...signedBlueprint } = blueprint;
  const files = {
    "python.exe": "runtime",
    "LICENSE.txt": "license",
    "THIRD-PARTY-NOTICES.txt": "notice",
    "SBOM.spdx.json": JSON.stringify({ spdxVersion: "SPDX-2.3" }),
  };
  const archive = Buffer.from("fake signed archive");
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
  packageEntry: ToolchainManifestV2Package,
): string {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const payload: ToolchainManifestV2Payload = {
    generatedAt: "2026-07-30T00:00:00.000Z",
    packages: [packageEntry],
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
  const data = fixture();
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[data.package.id];
  fs.writeFileSync(path.join(input, blueprint.archiveFilename), data.archive);
  const publicKey = writeSignedManifest(input, data.package);
  const extractArchive = (
    _archivePath: string,
    destination: string,
  ): void => {
    fs.mkdirSync(destination, { recursive: true });
    for (const [relativePath, contents] of Object.entries(data.files)) {
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
  assert.deepEqual(full.packages.map((entry) => entry.id), [data.package.id]);
  assert.equal(
    fs.existsSync(
      path.join(output, "toolchains", data.package.id, TOOLCHAIN_PACKAGE_RECEIPT),
    ),
    true,
  );

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

test("a failed Full rebuild preserves the previously committed resources", async (t) => {
  const { input, output } = testPaths(t);
  const data = fixture();
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[data.package.id];
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "sentinel.txt"), "previous");
  fs.writeFileSync(
    path.join(input, blueprint.archiveFilename),
    Buffer.from("tampered archive"),
  );
  const publicKey = writeSignedManifest(input, data.package);

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
