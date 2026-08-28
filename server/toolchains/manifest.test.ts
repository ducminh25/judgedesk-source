import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TOOLCHAIN_CATALOG,
  TOOLCHAIN_RELEASE_BLUEPRINTS,
  canonicalizeManifestPayload,
  loadOfficialManifest,
  normalizeHostArchitecture,
  validateManifestDocument,
} from "./manifest.js";
import type {
  ToolchainManifestV2Document,
  ToolchainManifestV2Package,
  ToolchainManifestV2Payload,
} from "./types.js";
import {
  CURRENT_RELEASE_TOOLCHAIN_KINDS,
  isCurrentReleaseToolchainKind,
  listCurrentReleaseManagedPackageIds,
} from "./release-scope.js";

test("host architecture normalization accepts Node and upstream aliases", () => {
  assert.equal(normalizeHostArchitecture("x64"), "x64");
  assert.equal(normalizeHostArchitecture("x86_64"), "x64");
  assert.equal(normalizeHostArchitecture("amd64"), "x64");
  assert.equal(normalizeHostArchitecture("arm64"), "arm64");
  assert.equal(normalizeHostArchitecture("aarch64"), "arm64");
  assert.equal(normalizeHostArchitecture("riscv64"), "riscv64");
});

test("current release scope contains only Themis languages and complete host packages", () => {
  assert.deepEqual(CURRENT_RELEASE_TOOLCHAIN_KINDS, [
    "cpp",
    "c",
    "python",
    "pascal",
    "java",
    "scratch",
  ]);
  for (const [platform, arch] of [
    ["win32", "x64"],
    ["darwin", "arm64"],
  ] as const) {
    const packageIds = listCurrentReleaseManagedPackageIds(platform, arch);
    assert.equal(new Set(packageIds).size, packageIds.length);
    for (const packageId of packageIds) {
      const catalog = TOOLCHAIN_CATALOG.find((entry) => entry.id === packageId);
      const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[packageId];
      assert.ok(catalog, `missing catalog entry for ${packageId}`);
      assert.ok(blueprint, `missing release blueprint for ${packageId}`);
      assert.equal(catalog.platform, platform);
      assert.equal(catalog.arch, arch);
      assert.equal(
        catalog.provides.every(isCurrentReleaseToolchainKind),
        true,
      );
    }
  }
  for (const deferred of ["go", "rust", "javascript", "csharp"] as const) {
    assert.equal(isCurrentReleaseToolchainKind(deferred), false);
  }
});

function validManifest() {
  return {
    schemaVersion: 1 as const,
    generatedAt: "2026-07-14T00:00:00.000Z",
    toolchains: TOOLCHAIN_CATALOG.map((entry) => ({
      ...entry,
      downloadUrl: `https://github.com/ducminh25/judgedesk/releases/download/toolchains-v1/${entry.id}.zip`,
      sha256: "a".repeat(64),
      sizeBytes: 1024,
    })),
  };
}

test("toolchain manifest accepts only catalog-matching packages with strict checksums", () => {
  const manifest = validateManifestDocument(validManifest());
  assert.equal(manifest.length, TOOLCHAIN_CATALOG.length);
  assert.equal(manifest[0].sha256, "a".repeat(64));
  assert.equal(manifest[0].manifestSchemaVersion, 1);

  const badChecksum = validManifest();
  badChecksum.toolchains[0].sha256 = "placeholder";
  assert.throws(() => validateManifestDocument(badChecksum), /invalid SHA-256/);

  const wrongExecutable = validManifest();
  wrongExecutable.toolchains[0].executableRelativePath = "../g++.exe";
  assert.throws(
    () => validateManifestDocument(wrongExecutable),
    /invalid executableRelativePath/,
  );
});

function validV2Package(index = 0): ToolchainManifestV2Package {
  const entry = TOOLCHAIN_CATALOG[index];
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[entry.id];
  const { archiveFilename: _archiveFilename, ...packagePolicy } = blueprint;
  return {
    ...packagePolicy,
    downloadUrl: `https://downloads.example.invalid/${entry.id}.archive`,
    sha256: "b".repeat(64),
    sizeBytes: 1024,
    installedSizeBytes: 4096,
  };
}

function signedV2Manifest(packages = [validV2Package()]): {
  document: ToolchainManifestV2Document;
  publicKey: string;
} {
  const payload: ToolchainManifestV2Payload = {
    generatedAt: "2026-07-30T00:00:00.000Z",
    packages,
  };
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalizeManifestPayload(payload), "utf8"),
    privateKey,
  );
  return {
    document: {
      schemaVersion: 2,
      signed: payload,
      signature: {
        algorithm: "ed25519",
        keyId: "test-toolchains-2026",
        value: signature.toString("base64"),
      },
    },
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("manifest v2 verifies its signed payload and normalizes multi-component packages", () => {
  const { document, publicKey } = signedV2Manifest();
  const manifest = validateManifestDocument(document, {
    trustedPublicKeys: { "test-toolchains-2026": publicKey },
  });
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].manifestSchemaVersion, 2);
  assert.equal(manifest[0].signingKeyId, "test-toolchains-2026");
  assert.equal(manifest[0].entrypointComponentId, "gcc.cxx");
  assert.deepEqual(
    manifest[0].components?.map((component) => component.id),
    ["gcc.cxx", "gcc.c", "gcc.root"],
  );
  assert.equal(manifest[0].license?.sbomPath, "SBOM.spdx.json");
});

test("manifest v2 rejects untrusted, tampered, ambiguous, and traversal metadata", () => {
  const untrusted = signedV2Manifest();
  assert.throws(
    () => validateManifestDocument(untrusted.document),
    /signing key .* is not trusted/,
  );

  const tampered = signedV2Manifest();
  tampered.document.signed.packages[0].sizeBytes += 1;
  assert.throws(
    () => validateManifestDocument(tampered.document, {
      trustedPublicKeys: { "test-toolchains-2026": tampered.publicKey },
    }),
    /signature verification failed/,
  );

  const duplicateComponents = validV2Package();
  duplicateComponents.components = [
    duplicateComponents.components[0],
    { ...duplicateComponents.components[0] },
  ];
  const duplicate = signedV2Manifest([duplicateComponents]);
  assert.throws(
    () => validateManifestDocument(duplicate.document, {
      trustedPublicKeys: { "test-toolchains-2026": duplicate.publicKey },
    }),
    /duplicate component IDs/,
  );

  const traversalPackage = validV2Package();
  traversalPackage.license = {
    ...traversalPackage.license,
    sbomPath: "../SBOM.spdx.json",
  };
  const traversal = signedV2Manifest([traversalPackage]);
  assert.throws(
    () => validateManifestDocument(traversal.document, {
      trustedPublicKeys: { "test-toolchains-2026": traversal.publicKey },
    }),
    /SBOM path is not a normalized relative path/,
  );

  const omittedLicensePackage = validV2Package();
  omittedLicensePackage.license = {
    ...omittedLicensePackage.license,
    licenseFiles: ["SOME-OTHER-LICENSE"],
  };
  const omittedLicense = signedV2Manifest([omittedLicensePackage]);
  assert.throws(
    () => validateManifestDocument(omittedLicense.document, {
      trustedPublicKeys: { "test-toolchains-2026": omittedLicense.publicKey },
    }),
    /omits required license/,
  );
});

test("official manifest loader follows HTTP redirects through fetch and validates the response", async () => {
  let requestedUrl = "";
  const signed = signedV2Manifest();
  const fetchImpl = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(signed.document), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const manifest = await loadOfficialManifest({
    forceRefresh: true,
    fetchImpl,
    manifestUrl: "https://example.invalid/toolchains-manifest.json",
    bundledManifestPath: pathForMissingBundledManifest(),
    trustedPublicKeys: { "test-toolchains-2026": signed.publicKey },
  });
  assert.equal(
    requestedUrl,
    "https://example.invalid/toolchains-manifest.json",
  );
  assert.equal(manifest.length, 1);
});

function pathForMissingBundledManifest(): string {
  return path.join(process.cwd(), ".missing-toolchain-manifest-for-test.json");
}

test("bundled signed manifest is preferred without touching the network", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signed = signedV2Manifest();
  const bundledManifestPath = path.join(root, "toolchains-manifest.json");
  fs.writeFileSync(bundledManifestPath, JSON.stringify(signed.document));
  let fetched = false;
  const manifest = await loadOfficialManifest({
    forceRefresh: false,
    bundledManifestPath,
    manifestUrl: "https://example.invalid/should-not-be-requested.json",
    trustedPublicKeys: { "test-toolchains-2026": signed.publicKey },
    fetchImpl: (async () => {
      fetched = true;
      throw new Error("network should not be used");
    }) as typeof fetch,
  });
  assert.equal(fetched, false);
  assert.equal(manifest[0].id, signed.document.signed.packages[0].id);
});
