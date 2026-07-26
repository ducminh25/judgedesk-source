import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOLCHAIN_CATALOG,
  loadOfficialManifest,
  validateManifestDocument,
} from "./manifest.js";

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
