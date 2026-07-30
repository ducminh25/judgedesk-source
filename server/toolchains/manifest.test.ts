import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  TOOLCHAIN_CATALOG,
  canonicalizeManifestPayload,
  loadOfficialManifest,
  validateManifestDocument,
} from "./manifest.js";
import type {
  ToolchainManifestV2Document,
  ToolchainManifestV2Package,
  ToolchainManifestV2Payload,
} from "./types.js";

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
  const roles = entry.kind === "cpp"
    ? ["compiler"] as const
    : ["submission-runtime", "checker-runtime"] as const;
  return {
    id: entry.id,
    kind: entry.kind,
    version: entry.version,
    platform: entry.platform,
    arch: entry.arch,
    minimumOs: entry.platform === "win32" ? "10.0" : "11.0",
    archiveFormat: entry.archiveFormat,
    downloadUrl: `https://downloads.example.invalid/${entry.id}.archive`,
    sha256: "b".repeat(64),
    sizeBytes: 1024,
    installedSizeBytes: 4096,
    entrypointComponentId: `${entry.kind}.entrypoint`,
    components: [
      {
        id: `${entry.kind}.entrypoint`,
        kind: "executable",
        relativePath: entry.executableRelativePath,
        roles,
      },
      {
        id: `${entry.kind}.support`,
        kind: "support-root",
        relativePath: ".",
        roles,
      },
    ],
    healthProbeId: `legacy.${entry.kind}.probes`,
    upstreamUrl: "https://example.invalid/upstream",
    license: {
      spdxExpression: "NOASSERTION",
      licenseFiles: entry.licenseFiles,
      noticeFiles: [],
      sbomPath: "SBOM.spdx.json",
    },
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
  assert.equal(manifest[0].entrypointComponentId, "cpp.entrypoint");
  assert.deepEqual(
    manifest[0].components?.map((component) => component.id),
    ["cpp.entrypoint", "cpp.support"],
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
  const fetchImpl = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(validManifest()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const manifest = await loadOfficialManifest({
    forceRefresh: true,
    fetchImpl,
    manifestUrl: "https://example.invalid/toolchains-manifest.json",
  });
  assert.equal(
    requestedUrl,
    "https://example.invalid/toolchains-manifest.json",
  );
  assert.equal(manifest.length, TOOLCHAIN_CATALOG.length);
});
