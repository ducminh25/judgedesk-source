import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TOOLCHAIN_RELEASE_BLUEPRINTS } from "../server/toolchains/manifest.js";
import { TOOLCHAIN_PACKAGE_RECEIPT } from "../server/toolchains/package-store.js";
import { prepareToolchainGateRoot } from "./prepare-toolchain-gate-root.js";
import { writeToolchainPackageMetadata } from "./write-toolchain-package-metadata.js";

const supportedHost =
  (process.platform === "win32" && process.arch === "x64")
  || (process.platform === "darwin" && process.arch === "arm64");

test(
  "gate preparation validates package metadata and replaces its test root atomically",
  {
    skip: supportedHost
      ? false
      : "toolchain gate roots support Windows x64 and macOS Apple Silicon only",
  },
  async (t) => {
    const packageId = process.platform === "win32"
      ? "node-windows-x64"
      : "node-macos-arm64";
    const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[packageId];
    const caseRoot = fs.mkdtempSync(
      path.join(path.resolve("build"), "toolchain-gate-root-test-"),
    );
    const inputRoot = path.join(caseRoot, "input");
    const fixtureRoot = path.join(caseRoot, "fixture");
    const outputRoot = path.join(caseRoot, "output");
    t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));

    fs.mkdirSync(inputRoot);
    fs.mkdirSync(fixtureRoot);
    fs.mkdirSync(outputRoot);
    fs.writeFileSync(path.join(outputRoot, "stale.txt"), "stale\n");
    fs.writeFileSync(
      path.join(inputRoot, blueprint.archiveFilename),
      "deterministic archive fixture\n",
    );

    for (const component of blueprint.components) {
      if (component.relativePath === ".") continue;
      const componentPath = path.join(
        fixtureRoot,
        ...component.relativePath.split("/"),
      );
      if (component.kind === "support-root") {
        fs.mkdirSync(componentPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(componentPath), { recursive: true });
        fs.writeFileSync(componentPath, "fixture executable\n");
      }
    }
    for (const relativePath of blueprint.license.licenseFiles) {
      const licensePath = path.join(
        fixtureRoot,
        ...relativePath.split("/"),
      );
      fs.mkdirSync(path.dirname(licensePath), { recursive: true });
      fs.writeFileSync(licensePath, "fixture upstream license\n");
    }
    writeToolchainPackageMetadata(fixtureRoot, packageId, {
      createdAt: "2026-07-31T00:00:00.000Z",
    });

    let verifiedExecutable = "";
    let verifiedHealthProbeId = "";
    const entrypoint = blueprint.entrypoints.find(
      (candidate) =>
        candidate.componentId === blueprint.entrypointComponentId,
    );
    assert.ok(entrypoint);
    await prepareToolchainGateRoot({
      inputRoot,
      outputRoot,
      requestedPackageIds: [packageId],
      extractArchive: (_archivePath, destination) => {
        fs.mkdirSync(destination, { recursive: true });
        fs.cpSync(fixtureRoot, destination, { recursive: true });
      },
      verifyExecutable: (executablePath, healthProbeId) => {
        verifiedExecutable = executablePath;
        verifiedHealthProbeId = healthProbeId || "";
        assert.equal(fs.statSync(executablePath).isFile(), true);
      },
    });

    const packageRoot = path.join(outputRoot, packageId);
    assert.equal(fs.existsSync(path.join(outputRoot, "stale.txt")), false);
    assert.equal(
      verifiedExecutable.endsWith(
        path.join(packageId, ...entrypoint.executableRelativePath.split("/")),
      ),
      true,
    );
    assert.equal(verifiedHealthProbeId, blueprint.healthProbeId);
    assert.equal(
      fs.statSync(
        path.join(
          packageRoot,
          ...entrypoint.executableRelativePath.split("/"),
        ),
      ).isFile(),
      true,
    );
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, TOOLCHAIN_PACKAGE_RECEIPT),
        "utf8",
      ),
    );
    assert.equal(receipt.packageId, packageId);
    assert.match(receipt.archiveSha256, /^[a-f0-9]{64}$/);
    const lock = JSON.parse(
      fs.readFileSync(
        path.join(outputRoot, ".judgedesk-local-gate-root.json"),
        "utf8",
      ),
    );
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.platform, process.platform);
    assert.equal(lock.arch, process.arch);
    assert.deepEqual(
      lock.packages.map((entry: { id: string }) => entry.id),
      [packageId],
    );
  },
);
