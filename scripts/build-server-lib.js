import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { buildSync } from "esbuild";
import { targetTripleForHost } from "./build-server-target.js";

export function resolveTarget(platform, architecture, envTarget) {
  const target = targetTripleForHost(platform, architecture);
  if (envTarget && envTarget !== target) {
    throw new Error(
      `Cannot build ${envTarget} sidecar from a ${platform}/${architecture} Node executable. Run this build on the matching host architecture.`,
    );
  }
  return target;
}

export function bundleServer(appRoot, srcFile, outFile) {
  console.log("Compiling server with esbuild...");
  const testlibPath = path.join(appRoot, "judgers", "testlib.h");
  const bundledTestlib = fs.existsSync(testlibPath)
    ? fs.readFileSync(testlibPath, "utf8")
    : "";
  buildSync({
    absWorkingDir: appRoot,
    entryPoints: [srcFile],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vite"],
    define: {
      __JUDGEDESK_TESTLIB__: JSON.stringify(bundledTestlib),
      __JUDGEDESK_BUILD_METADATA__: JSON.stringify(resolveBuildMetadata(appRoot)),
    },
    outfile: outFile,
    logLevel: "info",
  });
}

export function resolveBuildMetadata(appRoot, environment = process.env) {
  let appVersion = environment.npm_package_version || "development";
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
    );
    if (typeof packageJson.version === "string" && packageJson.version) {
      appVersion = packageJson.version;
    }
  } catch {
    // Source archives used by tests may not carry package.json.
  }

  let gitCommit = environment.JUDGEDESK_GIT_COMMIT || environment.GITHUB_SHA || "unknown";
  if (gitCommit === "unknown") {
    try {
      gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: appRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "unknown";
    } catch {
      // Release source archives may not contain .git.
    }
  }

  const sourceDateEpoch = Number.parseInt(environment.SOURCE_DATE_EPOCH || "", 10);
  const builtAt = Number.isFinite(sourceDateEpoch)
    ? new Date(sourceDateEpoch * 1000).toISOString()
    : environment.JUDGEDESK_BUILD_TIMESTAMP || new Date().toISOString();

  return {
    appVersion,
    gitCommit,
    buildNumber:
      environment.JUDGEDESK_BUILD_NUMBER
      || environment.CM_BUILD_ID
      || environment.GITHUB_RUN_NUMBER
      || "local",
    builtAt,
  };
}

export function generateSeaBlob(appRoot, configPath) {
  console.log("Generating SEA config blob...");
  execFileSync(process.execPath, ["--experimental-sea-config", configPath], {
    stdio: "inherit",
    cwd: appRoot,
  });
}

export function injectSeaBlob(
  appRoot,
  postjectCli,
  targetPath,
  blobPath,
  sentinel,
  platform,
) {
  const postjectArgs = [
    postjectCli,
    targetPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    sentinel,
  ];
  if (platform === "darwin") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  console.log(`Injecting SEA blob into ${targetPath}...`);
  execFileSync(process.execPath, postjectArgs, {
    stdio: "inherit",
    cwd: appRoot,
  });
}

export function prepareExecutableForInjection(targetPath, platform) {
  if (platform === "darwin") {
    console.log(`Removing the macOS signature from ${targetPath}...`);
    execFileSync("codesign", ["--remove-signature", targetPath], {
      stdio: "inherit",
    });
  }
  // Homebrew may install Node as 0555. copyFileSync preserves that mode, while
  // postject requires read/write access to modify the copied executable.
  fs.chmodSync(targetPath, fs.statSync(targetPath).mode | 0o200);
}

export function signExecutable(targetPath, platform) {
  if (platform === "darwin") {
    console.log(`Signing macOS executable ${targetPath}...`);
    execFileSync("codesign", ["--sign", "-", "--force", targetPath], {
      stdio: "inherit",
    });
  }
}

export function replaceFileAtomically(sourcePath, finalPath) {
  const targetDirectory = path.dirname(finalPath);
  fs.mkdirSync(targetDirectory, { recursive: true });
  const operationId = `${process.pid}-${crypto.randomUUID()}`;
  const stagedPath = path.join(
    targetDirectory,
    `.${path.basename(finalPath)}.${operationId}.tmp`,
  );
  const backupPath = path.join(
    targetDirectory,
    `.${path.basename(finalPath)}.${operationId}.backup`,
  );
  let previousFileBackedUp = false;

  try {
    fs.copyFileSync(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(finalPath)) {
      fs.renameSync(finalPath, backupPath);
      previousFileBackedUp = true;
    }
    fs.renameSync(stagedPath, finalPath);
    if (previousFileBackedUp) {
      fs.rmSync(backupPath, { force: true });
      previousFileBackedUp = false;
    }
  } catch (error) {
    if (
      previousFileBackedUp &&
      !fs.existsSync(finalPath) &&
      fs.existsSync(backupPath)
    ) {
      fs.renameSync(backupPath, finalPath);
      previousFileBackedUp = false;
    }
    throw error;
  } finally {
    fs.rmSync(stagedPath, { force: true });
    if (!previousFileBackedUp) fs.rmSync(backupPath, { force: true });
  }
}

export function runBuildWorkflow({
  appRoot,
  platform,
  architecture,
  envTarget,
  postjectCli,
  sentinel,
  targetDirectory,
  srcFile,
  seaConfigJson,
  seaBlobFile,
}) {
  const target = resolveTarget(platform, architecture, envTarget);
  const extension = platform === "win32" ? ".exe" : "";
  const finalTargetPath = path.join(
    targetDirectory,
    `server-${target}${extension}`,
  );

  // Create temporary directory for building
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "themis-sea-"));
  const tempTargetPath = path.join(tempDir, `server-${target}${extension}`);
  const tempBlobPath = path.join(appRoot, seaBlobFile); // SEA blob needs to be at path configured in sea-config.json

  try {
    // 1. Bundle server.ts to dist/server.cjs
    const distDir = path.dirname(path.join(appRoot, "dist/server.cjs"));
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }
    bundleServer(appRoot, srcFile, "dist/server.cjs");

    // 2. Generate SEA Blob
    generateSeaBlob(appRoot, seaConfigJson);

    // 3. Copy process.execPath to temporary target file
    fs.copyFileSync(process.execPath, tempTargetPath);

    // 4. Node's macOS executable is signed. Remove that signature before
    // modifying the Mach-O file, as required by Node's SEA documentation.
    prepareExecutableForInjection(tempTargetPath, platform);

    // 5. Inject SEA blob into temporary target
    injectSeaBlob(
      appRoot,
      postjectCli,
      tempTargetPath,
      tempBlobPath,
      sentinel,
      platform,
    );

    // 6. Sign the modified binary if on macOS
    signExecutable(tempTargetPath, platform);

    // 7. Stage on the target filesystem, then atomically swap the final file.
    replaceFileAtomically(tempTargetPath, finalTargetPath);
    console.log(
      `Backend sidecar successfully built and saved to ${finalTargetPath}`,
    );
  } catch (error) {
    console.error("SEA build failed, cleaning up temp artifacts...");
    throw error;
  } finally {
    // Cleanup temporary workspace
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.warn("Failed to remove temp directory:", err.message);
    }
    try {
      if (fs.existsSync(tempBlobPath)) {
        fs.rmSync(tempBlobPath, { force: true });
      }
    } catch (err) {
      console.warn("Failed to clean up blob:", err.message);
    }
  }
}
