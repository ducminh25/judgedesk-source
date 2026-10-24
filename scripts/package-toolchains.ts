import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildLinuxPackage, buildLinuxPackagedNativeArgs } from "./linux-toolchain-packaging.js";
import {
  buildDotnetCscArgs,
} from "../server/judge/compiler.js";
import {
  buildManagedPascalSupportArgs,
  buildNativeCompilationRecipe,
} from "../server/judge/language-adapters.js";
import {
  TOOLCHAIN_RELEASE_BLUEPRINTS,
} from "../server/toolchains/manifest.js";
import {
  validateExtractedLinks,
} from "../server/toolchains/installer.js";
import type {
  HostArchitecture,
  HostPlatform,
} from "../server/languages/contracts.js";
import type {
  ToolchainReleaseBlueprint,
} from "../server/toolchains/types.js";
import {
  listCurrentReleaseManagedPackageIds,
} from "../server/toolchains/release-scope.js";
import {
  TOOLCHAIN_RELEASE_SOURCES,
  type ToolchainReleaseSource,
  type ToolchainUpstreamInput,
} from "./toolchain-release-sources.js";
import {
  writeToolchainPackageMetadata,
} from "./write-toolchain-package-metadata.js";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const COPY_MODE = fs.constants.COPYFILE_FICLONE;

export interface PackagingHost {
  platform: HostPlatform;
  arch: HostArchitecture;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

function assertBuildChild(candidate: string, label: string): void {
  const buildRoot = path.join(path.resolve(process.cwd()), "build");
  const resolved = path.resolve(candidate);
  if (resolved === buildRoot || !isInside(buildRoot, resolved)) {
    throw new Error(`${label} must be a child of the workspace build directory.`);
  }
}

export function resolvePackagingHost(
  platform: NodeJS.Platform = os.platform(),
  architecture: string = os.arch(),
): PackagingHost {
  if (platform === "win32" && architecture === "x64") {
    return { platform: "win32", arch: "x64" };
  }
  if (platform === "darwin" && architecture === "arm64") {
    return { platform: "darwin", arch: "arm64" };
  }
  if (platform === "linux" && architecture === "x64") {
    return { platform: "linux", arch: "x64" };
  }
  throw new Error(
    `Unsupported toolchain packaging host: ${platform}/${architecture}. `
      + "JudgeDesk releases Windows x64, macOS Apple Silicon and Linux x64 only.",
  );
}

export function selectHostToolchainReleases(
  host: PackagingHost,
  requestedPackageIds: readonly string[] = [],
): ToolchainReleaseSource[] {
  const requested = new Set(requestedPackageIds);
  if (requested.size !== requestedPackageIds.length) {
    throw new Error("Requested toolchain package IDs must be unique.");
  }
  for (const packageId of requested) {
    const release = TOOLCHAIN_RELEASE_SOURCES[packageId];
    if (!release) throw new Error(`Unknown toolchain package '${packageId}'.`);
    if (release.platform !== host.platform || release.arch !== host.arch) {
      throw new Error(
        `Toolchain package '${packageId}' is not built on ${host.platform}/${host.arch}.`,
      );
    }
  }
  const releasePackageIds = new Set(
    listCurrentReleaseManagedPackageIds(host.platform, host.arch),
  );
  const selected = Object.values(TOOLCHAIN_RELEASE_SOURCES)
    .filter((release) =>
      release.platform === host.platform
      && release.arch === host.arch
      && (
        requested.size > 0
          ? requested.has(release.packageId)
          : releasePackageIds.has(release.packageId)
      )
    )
    .sort((left, right) => left.packageId.localeCompare(right.packageId));
  if (selected.length === 0) {
    throw new Error(`No toolchain release packages exist for ${host.platform}/${host.arch}.`);
  }
  if (requested.size === 0 && selected.length !== releasePackageIds.size) {
    throw new Error(
      `The current release package set is incomplete for ${host.platform}/${host.arch}.`,
    );
  }
  return selected;
}

export function buildPackagingPascalSupportArgs(
  platform: NodeJS.Platform,
  packageRoot: string,
  macosSdkDirectory?: string,
): string[] {
  if (platform === "darwin") {
    if (
      !macosSdkDirectory
      || !path.isAbsolute(macosSdkDirectory)
      || !fs.statSync(macosSdkDirectory, { throwIfNoEntry: false })?.isDirectory()
    ) {
      throw new Error("The macOS SDK is required to smoke-test packaged FPC.");
    }
    return [
      `-XR${fs.realpathSync(macosSdkDirectory)}`,
      ...buildManagedPascalSupportArgs(platform, packageRoot),
    ];
  }
  return buildManagedPascalSupportArgs(platform, packageRoot);
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(-32_000);
    throw new Error(
      `Command failed (${result.status}): ${command} ${args.join(" ")}`
        + (detail ? `\n${detail}` : ""),
    );
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function hashFile(
  filePath: string,
): Promise<{ sha256: string; sha512: string }> {
  const sha256 = crypto.createHash("sha256");
  const sha512 = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(filePath)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return {
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("hex"),
  };
}

async function verifyInputFile(
  filePath: string,
  input: ToolchainUpstreamInput,
): Promise<boolean> {
  const metadata = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.size <= 0 || metadata.size > MAX_SOURCE_BYTES) {
    return false;
  }
  const hashes = await hashFile(filePath);
  return hashes.sha256 === input.sha256
    && (!input.sha512 || hashes.sha512 === input.sha512);
}

async function downloadInput(
  input: ToolchainUpstreamInput,
  cacheRoot: string,
): Promise<string> {
  const destination = path.join(
    cacheRoot,
    `${input.sha256}-${input.fileName}`,
  );
  if (await verifyInputFile(destination, input)) return destination;
  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporary = `${destination}.partial-${process.pid}-${crypto.randomUUID()}`;
    try {
      const response = await fetch(input.url, {
        redirect: "follow",
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "JudgeDesk-Toolchain-Packager/2",
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      const announced = Number(response.headers.get("content-length") || 0);
      if (announced > MAX_SOURCE_BYTES) {
        throw new Error("upstream source exceeds the release size limit");
      }
      const sha256 = crypto.createHash("sha256");
      const sha512 = crypto.createHash("sha512");
      const handle = fs.openSync(temporary, "wx");
      let received = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = Buffer.from(value);
          received += bytes.byteLength;
          if (received > MAX_SOURCE_BYTES) {
            throw new Error("upstream source exceeded the release size limit");
          }
          sha256.update(bytes);
          sha512.update(bytes);
          fs.writeSync(handle, bytes);
        }
      } finally {
        fs.closeSync(handle);
      }
      if (
        received === 0
        || sha256.digest("hex") !== input.sha256
        || (input.sha512 && sha512.digest("hex") !== input.sha512)
      ) {
        throw new Error("pinned checksum verification failed");
      }
      fs.renameSync(temporary, destination);
      return destination;
    } catch (error) {
      lastError = error;
      fs.rmSync(temporary, { force: true });
      if (attempt < 3) {
        console.warn(
          `Retrying ${input.fileName} after attempt ${attempt} failed.`,
        );
      }
    }
  }
  throw new Error(
    `Unable to download verified input '${input.fileName}': ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function validateArchiveEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (!normalized || normalized === ".") continue;
    if (
      normalized.startsWith("/")
      || /^[a-z]:/i.test(normalized)
      || normalized.split("/").includes("..")
    ) {
      throw new Error(`Upstream archive contains an unsafe path: ${entry}`);
    }
  }
}

function extractArchive(archivePath: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: false });
  const listing = run("tar", ["-tf", archivePath], { timeoutMs: 2 * 60_000 });
  validateArchiveEntries(listing.split(/\r?\n/).filter(Boolean));
  run(
    "tar",
    ["-xf", archivePath, "-C", destination],
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  validateExtractedLinks(destination);
}

function copyTree(source: string, destination: string): void {
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Expected release directory is missing: ${source}`);
  }
  if (fs.existsSync(destination)) {
    throw new Error(`Package destination already exists: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    mode: COPY_MODE,
    verbatimSymlinks: true,
  });
}

function primaryExecutableRelativePath(
  blueprint: ToolchainReleaseBlueprint,
): string {
  const component = blueprint.components.find(
    (candidate) => candidate.id === blueprint.entrypointComponentId,
  );
  if (!component || component.kind !== "executable") {
    throw new Error(
      `Package '${blueprint.id}' has no executable entrypoint component.`,
    );
  }
  return component.relativePath;
}

function copyFile(source: string, destination: string): void {
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Expected release file is missing: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, COPY_MODE);
}

function primaryInputPath(
  release: ToolchainReleaseSource,
  inputs: ReadonlyMap<string, string>,
): string {
  const primary = release.inputs.find((input) => input.role === "primary")!;
  const inputPath = inputs.get(primary.id);
  if (!inputPath) throw new Error(`Primary input is missing for '${release.packageId}'.`);
  return inputPath;
}

function normalizeArchiveRoot(
  release: ToolchainReleaseSource,
  inputPath: string,
  workRoot: string,
  packageRoot: string,
): void {
  if (!("rootPath" in release.recipe)) {
    throw new Error(`Package '${release.packageId}' has no archive root recipe.`);
  }
  const extracted = path.join(workRoot, "extracted");
  extractArchive(inputPath, extracted);
  const sourceRoot = release.recipe.rootPath === "."
    ? extracted
    : path.join(
        extracted,
        ...release.recipe.rootPath.replaceAll("\\", "/").split("/"),
      );
  if (!isInside(extracted, sourceRoot)) {
    throw new Error(`Archive root escapes extraction for '${release.packageId}'.`);
  }
  copyTree(sourceRoot, packageRoot);
}

function copyAdditionalInputs(
  release: ToolchainReleaseSource,
  inputs: ReadonlyMap<string, string>,
  packageRoot: string,
): void {
  for (const input of release.inputs) {
    if (input.role !== "license") continue;
    const inputPath = inputs.get(input.id);
    if (!inputPath || !input.destinationRelativePath) {
      throw new Error(`License input '${input.id}' is incomplete.`);
    }
    copyFile(
      inputPath,
      path.join(
        packageRoot,
        ...input.destinationRelativePath.replaceAll("\\", "/").split("/"),
      ),
    );
  }
}

function writeSourceNotice(
  release: ToolchainReleaseSource,
  blueprint: ToolchainReleaseBlueprint,
  packageRoot: string,
): void {
  if (!blueprint.license.licenseFiles.includes("SOURCE.txt")) return;
  const lines = [
    `JudgeDesk package: ${release.packageId} ${blueprint.version}`,
    `Packaging: ${release.packagingDescription}`,
    "",
    "Verified upstream inputs:",
    ...release.inputs.map((input) =>
      `- ${input.role}: ${input.url}\n  SHA-256: ${input.sha256}`
    ),
  ];
  if (release.packageId === "gcc-windows-x64") {
    lines.push(
      "",
      "Corresponding GCC source: https://gcc.gnu.org/pub/gcc/releases/gcc-14.2.0/",
      "WinLibs build recipes: https://github.com/brechtsanders/winlibs_mingw",
    );
  }
  fs.writeFileSync(
    path.join(packageRoot, "SOURCE.txt"),
    `${lines.join("\n")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function isolatedInstallerEnvironment(workRoot: string): NodeJS.ProcessEnv {
  const localAppData = path.join(workRoot, "installer-local-app-data");
  const appData = path.join(workRoot, "installer-roaming-app-data");
  const temporary = path.join(workRoot, "installer-temp");
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(temporary, { recursive: true });
  return {
    ...process.env,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    TEMP: temporary,
    TMP: temporary,
  };
}

function packageFpcWindows(
  installer: string,
  sourceArchive: string,
  workRoot: string,
  packageRoot: string,
): void {
  if (process.platform !== "win32") {
    throw new Error("The Windows FPC package must be built on Windows.");
  }
  const installed = path.join(workRoot, "fpc-installed");
  const environment = isolatedInstallerEnvironment(workRoot);
  run(
    installer,
    [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/SP-",
      "/NOICONS",
      "/TASKS=",
      `/DIR=${installed}`,
    ],
    { env: environment, timeoutMs: COMMAND_TIMEOUT_MS },
  );
  try {
    fs.mkdirSync(packageRoot);
    copyTree(path.join(installed, "bin", "i386-win32"), path.join(packageRoot, "bin"));
    copyTree(
      path.join(installed, "units", "x86_64-win64"),
      path.join(packageRoot, "units", "x86_64-win64"),
    );
    const extractedSource = path.join(workRoot, "fpc-source");
    extractArchive(sourceArchive, extractedSource);
    const sourceRoot = path.join(extractedSource, "fpc-3.2.2");
    const bootstrapBin = path.join(installed, "bin", "i386-win32");
    const bootstrapDriver = path.join(bootstrapBin, "fpc.exe");
    run(
      path.join(bootstrapBin, "make.exe"),
      [
        "-C",
        sourceRoot,
        "compiler_cycle",
        "OS_TARGET=win64",
        "CPU_TARGET=x86_64",
        `FPC=${bootstrapDriver}`,
        "OPT=-WR",
      ],
      {
        env: {
          ...process.env,
          PATH: `${bootstrapBin}${path.delimiter}${process.env.PATH || ""}`,
        },
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
    );
    const nativeCompiler = path.join(sourceRoot, "compiler", "ppcx64.exe");
    const peHeader = run(
      path.join(bootstrapBin, "x86_64-win64-objdump.exe"),
      ["-f", nativeCompiler],
    );
    if (
      !peHeader.includes("file format pei-x86-64")
      || !peHeader.includes("HAS_RELOC")
    ) {
      throw new Error(
        "Rebuilt FPC compiler is not a relocatable native Windows x64 executable.",
      );
    }
    if (!run(nativeCompiler, ["-iV"]).split(/\r?\n/).includes("3.2.2")) {
      throw new Error("Rebuilt FPC compiler returned an unexpected version.");
    }
    copyFile(nativeCompiler, path.join(packageRoot, "bin", "ppcx64.exe"));
    const upstreamLicenses = path.join(installed, "doc", "fpc");
    const packageLicenses = path.join(packageRoot, "licenses");
    for (const license of ["COPYING", "COPYING.v2", "copying.fpc"]) {
      copyFile(
        path.join(upstreamLicenses, license),
        path.join(packageLicenses, license),
      );
    }
  } finally {
    const uninstaller = path.join(installed, "unins000.exe");
    if (fs.statSync(uninstaller, { throwIfNoEntry: false })?.isFile()) {
      try {
        run(
          uninstaller,
          ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
          { env: environment, timeoutMs: 2 * 60_000 },
        );
      } catch (error) {
        console.warn(
          `FPC build-root uninstaller cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function findNamedEntry(root: string, expectedName: string): string {
  const pending = [root];
  const matches: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.name === expectedName) matches.push(entryPath);
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one '${expectedName}' in the upstream package, found ${matches.length}.`,
    );
  }
  return matches[0];
}

function packageFpcMacos(
  dmg: string,
  workRoot: string,
  packageRoot: string,
): void {
  if (process.platform !== "darwin" || os.arch() !== "arm64") {
    throw new Error("The macOS FPC package must be built on Apple Silicon.");
  }
  const mountRoot = path.join(workRoot, "fpc-mount");
  const expanded = path.join(workRoot, "fpc-expanded");
  fs.mkdirSync(mountRoot);
  let attached = false;
  try {
    run(
      "hdiutil",
      ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, dmg],
      { timeoutMs: 2 * 60_000 },
    );
    attached = true;
    const packagePath = findNamedEntry(
      mountRoot,
      "fpc-3.2.2-intelarm64-macosx.pkg",
    );
    run("pkgutil", ["--expand-full", packagePath, expanded]);
    const upstreamRoot = path.join(expanded, "Payload", "usr", "local");
    fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
    copyFile(
      path.join(upstreamRoot, "bin", "fpc"),
      path.join(packageRoot, "bin", "fpc"),
    );
    copyFile(
      path.join(upstreamRoot, "lib", "fpc", "3.2.2", "ppca64"),
      path.join(packageRoot, "bin", "ppca64"),
    );
    copyTree(
      path.join(
        upstreamRoot,
        "lib",
        "fpc",
        "3.2.2",
        "units",
        "aarch64-darwin",
      ),
      path.join(packageRoot, "units", "aarch64-darwin"),
    );
    copyTree(
      path.join(
        upstreamRoot,
        "share",
        "doc",
        "fpc-3.2.2",
        "license",
      ),
      path.join(packageRoot, "licenses"),
    );
    fs.chmodSync(path.join(packageRoot, "bin", "fpc"), 0o755);
    fs.chmodSync(path.join(packageRoot, "bin", "ppca64"), 0o755);
  } finally {
    if (attached) {
      run("hdiutil", ["detach", mountRoot], { timeoutMs: 2 * 60_000 });
    }
  }
}

function toGitBashPath(windowsPath: string): string {
  const resolved = path.resolve(windowsPath);
  const match = /^([a-z]):[\\/](.*)$/i.exec(resolved);
  if (!match) {
    throw new Error(`Git Bash cannot map release path '${windowsPath}'.`);
  }
  return `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function packageRust(
  release: ToolchainReleaseSource,
  inputPath: string,
  workRoot: string,
  packageRoot: string,
): void {
  if (release.recipe.kind !== "rust-installer") {
    throw new Error(`Package '${release.packageId}' has no Rust recipe.`);
  }
  const extracted = path.join(workRoot, "rust-extracted");
  extractArchive(inputPath, extracted);
  const installerRoot = path.join(
    extracted,
    ...release.recipe.rootPath.split("/"),
  );
  const installer = path.join(installerRoot, "install.sh");
  const bash = process.platform === "win32"
    ? process.env.JUDGEDESK_GIT_BASH
      || String.raw`C:\Program Files\Git\bin\bash.exe`
    : "/bin/bash";
  if (!fs.statSync(bash, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Required Bash executable is missing: ${bash}`);
  }
  const scriptArgument = process.platform === "win32"
    ? toGitBashPath(installer)
    : installer;
  const prefixArgument = process.platform === "win32"
    ? toGitBashPath(packageRoot)
    : packageRoot;
  run(
    bash,
    [
      scriptArgument,
      `--prefix=${prefixArgument}`,
      `--components=${release.recipe.components.join(",")}`,
      "--disable-ldconfig",
    ],
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  for (const license of ["LICENSE-APACHE", "LICENSE-MIT", "COPYRIGHT"]) {
    const destination = path.join(packageRoot, license);
    if (!fs.existsSync(destination)) {
      copyFile(path.join(installerRoot, license), destination);
    }
  }
}

function packageTreeForRelease(
  release: ToolchainReleaseSource,
  inputs: ReadonlyMap<string, string>,
  workRoot: string,
  packageRoot: string,
): void {
  const primary = primaryInputPath(release, inputs);
  if (release.platform === "linux") {
    buildLinuxPackage(release, inputs, workRoot, packageRoot, run);
  } else if (release.recipe.kind === "archive-root") {
    normalizeArchiveRoot(release, primary, workRoot, packageRoot);
  } else if (release.recipe.kind === "fpc-windows-installer") {
    const sourceArchive = inputs.get("fpc-source");
    if (!sourceArchive) {
      throw new Error("FPC Windows source archive is missing.");
    }
    packageFpcWindows(primary, sourceArchive, workRoot, packageRoot);
  } else if (release.recipe.kind === "fpc-macos-dmg") {
    fs.mkdirSync(packageRoot);
    packageFpcMacos(primary, workRoot, packageRoot);
  } else if (release.recipe.kind === "rust-installer") {
    packageRust(release, primary, workRoot, packageRoot);
  } else {
    throw new Error(`Unsupported packaging recipe: ${release.recipe.kind}`);
  }
  copyAdditionalInputs(release, inputs, packageRoot);
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[release.packageId];
  writeSourceNotice(release, blueprint, packageRoot);
  validateExtractedLinks(packageRoot);
}

function smokeOutput(commandOutput: string, packageId: string): void {
  if (!commandOutput.split(/\r?\n/).some((line) => line.trim() === "42")) {
    throw new Error(`Package '${packageId}' compile-run smoke returned wrong output.`);
  }
}

function resolveMacosPackagingSdk(): string {
  const sdkDirectory = run(
    "/usr/bin/xcrun",
    ["--sdk", "macosx", "--show-sdk-path"],
  ).trim();
  if (
    !path.isAbsolute(sdkDirectory)
    || !fs.statSync(sdkDirectory, { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new Error("xcrun did not return a usable macOS SDK directory.");
  }
  return fs.realpathSync(sdkDirectory);
}

function smokeDotnet(
  executable: string,
  packageRoot: string,
  workspace: string,
): void {
  const sourcePath = path.join(workspace, "Submission.cs");
  const outputDirectory = path.join(workspace, "out");
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(
    sourcePath,
    "using System; public static class Program { public static void Main() { Console.WriteLine(42); } }\n",
  );
  const [command, compilerAssembly, ...compilerArguments] = buildDotnetCscArgs({
    workspacePath: workspace,
    sourcePath,
    outputDirectory,
    toolchainRoot: packageRoot,
  });
  const responseFile = path.join(workspace, "csc.rsp");
  fs.writeFileSync(
    responseFile,
    `${compilerArguments.map((argument) =>
      /[\s#]/.test(argument) ? `"${argument}"` : argument
    ).join("\n")}\n`,
  );
  const dotnetHome = path.join(workspace, "dotnet-home");
  const nugetPackages = path.join(workspace, "nuget-packages");
  fs.mkdirSync(dotnetHome);
  fs.mkdirSync(nugetPackages);
  const environment = {
    ...process.env,
    DOTNET_ROOT: packageRoot,
    DOTNET_CLI_HOME: dotnetHome,
    NUGET_PACKAGES: nugetPackages,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_MULTILEVEL_LOOKUP: "0",
    MSBUILDDISABLENODEREUSE: "1",
    PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ""}`,
  };
  run(
    executable,
    [command, compilerAssembly, `@${responseFile}`],
    { cwd: workspace, env: environment },
  );
  fs.writeFileSync(
    path.join(outputDirectory, "JudgeDeskSubmission.runtimeconfig.json"),
    `${JSON.stringify({
      runtimeOptions: {
        tfm: "net10.0",
        framework: {
          name: "Microsoft.NETCore.App",
          version: "10.0.10",
        },
        rollForward: "Disable",
      },
    }, null, 2)}\n`,
  );
  smokeOutput(
    run(
      executable,
      [path.join(outputDirectory, "JudgeDeskSubmission.dll")],
      { cwd: outputDirectory, env: environment },
    ),
    "dotnet",
  );
}

function smokePackage(
  release: ToolchainReleaseSource,
  packageRoot: string,
  workRoot: string,
): void {
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[release.packageId];
  const executable = path.join(
    packageRoot,
    ...primaryExecutableRelativePath(blueprint).split("/"),
  );
  const workspace = path.join(workRoot, "smoke");
  fs.mkdirSync(workspace);
  const output = path.join(
    workspace,
    process.platform === "win32" ? "program.exe" : "program",
  );

  if (blueprint.kind === "python") {
    smokeOutput(
      run(executable, ["-I", "-S", "-c", "print(40 + 2)"], { cwd: workspace }),
      release.packageId,
    );
    return;
  }
  if (blueprint.kind === "javascript") {
    smokeOutput(
      run(executable, ["-e", "process.stdout.write(String(40 + 2) + '\\n')"], {
        cwd: workspace,
      }),
      release.packageId,
    );
    return;
  }
  if (blueprint.kind === "scratch") {
    const projectJson = path.join(workspace, "project.json");
    fs.writeFileSync(
      projectJson,
      JSON.stringify({
        targets: [
          {
            isStage: true,
            name: "Stage",
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [
              {
                assetId: "cd21514d0531fdffb22204e0ec5ed84a",
                name: "backdrop1",
                md5ext: "cd21514d0531fdffb22204e0ec5ed84a.svg",
                dataFormat: "svg",
                rotationCenterX: 240,
                rotationCenterY: 180,
              },
            ],
            sounds: [],
            volume: 100,
            layerOrder: 0,
            tempo: 60,
            videoTransparency: 50,
            videoState: "on",
            textToSpeechLanguage: null,
          },
          {
            isStage: false,
            name: "Sprite1",
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {
              start: {
                opcode: "event_whenflagclicked",
                next: "say",
                parent: null,
                inputs: {},
                fields: {},
                shadow: false,
                topLevel: true,
              },
              say: {
                opcode: "looks_say",
                next: null,
                parent: "start",
                inputs: {
                  MESSAGE: [1, [10, "42"]],
                },
                fields: {},
                shadow: false,
                topLevel: false,
              },
            },
            comments: {},
            currentCostume: 0,
            costumes: [
              {
                assetId: "bcf454acf82e4504149f7ffe07081dbc",
                name: "costume1",
                bitmapResolution: 1,
                md5ext: "bcf454acf82e4504149f7ffe07081dbc.svg",
                dataFormat: "svg",
                rotationCenterX: 48,
                rotationCenterY: 50,
              },
            ],
            sounds: [],
            volume: 100,
            layerOrder: 1,
            visible: true,
            x: 0,
            y: 0,
            size: 100,
            direction: 90,
            draggable: false,
            rotationStyle: "all around",
          },
        ],
        monitors: [],
        extensions: [],
        meta: {
          semver: "3.0.0",
          vm: "0.2.0",
          agent: "JudgeDesk",
        },
      }),
      "utf8",
    );
    smokeOutput(
      run(executable, [projectJson], {
        cwd: workspace,
      }),
      release.packageId,
    );
    return;
  }
  if (blueprint.kind === "csharp") {
    smokeDotnet(executable, packageRoot, workspace);
    return;
  }
  if (blueprint.kind === "java") {
    const runtimeComponent = blueprint.components.find(
      (component) => component.id === "java.runtime",
    );
    if (!runtimeComponent || runtimeComponent.kind !== "executable") {
      throw new Error(
        `Package '${release.packageId}' has no Java runtime component.`,
      );
    }
    const runtimeExecutable = path.join(
      packageRoot,
      ...runtimeComponent.relativePath.split("/"),
    );
    const source = path.join(workspace, "Main.java");
    const classes = path.join(workspace, "classes");
    fs.mkdirSync(classes);
    fs.writeFileSync(
      source,
      "public class Main { public static void main(String[] args) { System.out.println(42); } }\n",
    );
    run(
      executable,
      ["--release", "21", "-encoding", "UTF-8", "-g:none", "-proc:none", "-d", classes, source],
      {
        cwd: workspace,
        env: {
          ...process.env,
          JAVA_HOME: packageRoot,
          PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ""}`,
        },
      },
    );
    smokeOutput(
      run(
        runtimeExecutable,
        ["-cp", classes, "Main"],
        {
          cwd: workspace,
          env: {
            ...process.env,
            JAVA_HOME: packageRoot,
            PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ""}`,
          },
        },
      ),
      release.packageId,
    );
    return;
  }

  const extension = blueprint.kind === "cpp"
    ? ".cpp"
    : blueprint.kind === "pascal"
      ? ".pas"
      : blueprint.kind === "go"
        ? ".go"
        : ".rs";
  const source = path.join(workspace, `main${extension}`);
  if (blueprint.kind === "cpp") {
    fs.writeFileSync(source, "#include <iostream>\nint main() { std::cout << 42 << '\\n'; }\n");
    for (const language of ["cpp", "c"] as const) {
      const languageSource = language === "cpp"
        ? source
        : path.join(workspace, "main.c");
      const languageOutput = language === "cpp"
        ? output
        : path.join(workspace, "program-c.exe");
      if (language === "c") {
        fs.writeFileSync(languageSource, "#include <stdio.h>\nint main(void) { puts(\"42\"); }\n");
      }
      const recipe = buildNativeCompilationRecipe(
        language,
        process.platform,
        languageSource,
        languageOutput,
      );
      const linuxEntrypoint = blueprint.entrypoints.find((entry) => entry.kind === language);
      const driver = release.platform === "linux" && linuxEntrypoint
        ? path.join(packageRoot, linuxEntrypoint.executableRelativePath) : executable;
      run(driver, release.platform === "linux"
        ? buildLinuxPackagedNativeArgs(language, packageRoot, languageSource, languageOutput)
        : recipe.args, { cwd: workspace });
      smokeOutput(run(languageOutput, [], { cwd: workspace }), release.packageId);
    }
    return;
  }
  if (blueprint.kind === "pascal") {
    fs.writeFileSync(source, "program Main; begin writeln(42); end.\n");
    const recipe = buildNativeCompilationRecipe(
      "pascal",
      process.platform,
      source,
      output,
    );
    run(
      executable,
      [
        ...buildPackagingPascalSupportArgs(
          process.platform,
          packageRoot,
          process.platform === "darwin"
            ? resolveMacosPackagingSdk()
            : undefined,
        ),
        ...recipe.args,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ""}`,
        },
      },
    );
    smokeOutput(run(output, [], { cwd: workspace }), release.packageId);
    return;
  }
  if (blueprint.kind === "go") {
    fs.writeFileSync(source, "package main\nimport \"fmt\"\nfunc main() { fmt.Println(42) }\n");
    const recipe = buildNativeCompilationRecipe(
      "go",
      process.platform,
      source,
      output,
    );
    const goCache = path.join(workspace, "go-cache");
    for (const directory of ["go-cache", "go-mod-cache", "go-tmp"]) {
      fs.mkdirSync(path.join(workspace, directory));
    }
    run(executable, recipe.args, {
      cwd: workspace,
      env: {
        ...process.env,
        ...recipe.environment,
        GOROOT: packageRoot,
        GOCACHE: goCache,
        GOMODCACHE: path.join(workspace, "go-mod-cache"),
        GOTMPDIR: path.join(workspace, "go-tmp"),
        GOMAXPROCS: "4",
        PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    smokeOutput(run(output, [], { cwd: workspace }), release.packageId);
    return;
  }
  fs.writeFileSync(source, "fn main() { println!(\"42\"); }\n");
  const recipe = buildNativeCompilationRecipe(
    "rust",
    process.platform,
    source,
    output,
  );
  run(executable, recipe.args, {
    cwd: workspace,
    env: {
      ...process.env,
      ...recipe.environment,
      PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
  smokeOutput(run(output, [], { cwd: workspace }), release.packageId);
}

function verifyPackageTree(
  blueprint: ToolchainReleaseBlueprint,
  packageRoot: string,
): void {
  for (const component of blueprint.components) {
    const componentPath = component.relativePath === "."
      ? packageRoot
      : path.join(packageRoot, ...component.relativePath.split("/"));
    const metadata = fs.statSync(componentPath, { throwIfNoEntry: false });
    if (
      !metadata
      || (component.kind === "executable" && !metadata.isFile())
      || (component.kind === "support-root" && !metadata.isDirectory())
    ) {
      throw new Error(
        `Package '${blueprint.id}' is missing component '${component.id}'.`,
      );
    }
  }
  for (const relativePath of [
    ...blueprint.license.licenseFiles,
    ...blueprint.license.noticeFiles,
    blueprint.license.sbomPath,
    "SOURCE-PROVENANCE.json",
  ]) {
    if (
      !fs.statSync(
        path.join(packageRoot, ...relativePath.split("/")),
        { throwIfNoEntry: false },
      )?.isFile()
    ) {
      throw new Error(
        `Package '${blueprint.id}' is missing metadata '${relativePath}'.`,
      );
    }
  }
}

function archivePackage(
  packageRoot: string,
  outputPath: string,
  format: ToolchainReleaseBlueprint["archiveFormat"],
): void {
  if (format === "tar.zst") {
    throw new Error("Release packager does not emit tar.zst archives.");
  }
  const python = process.env.JUDGEDESK_PACKAGING_PYTHON
    || (process.platform === "win32" ? "python" : "python3");
  run(
    python,
    [
      path.join(process.cwd(), "scripts", "create-toolchain-archive.py"),
      packageRoot,
      outputPath,
      format,
    ],
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
}

async function packageRelease(
  release: ToolchainReleaseSource,
  cacheRoot: string,
  operationRoot: string,
  outputRoot: string,
): Promise<void> {
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[release.packageId];
  const packageWork = path.join(operationRoot, release.packageId);
  const packageRoot = path.join(packageWork, "package");
  fs.mkdirSync(packageWork);
  const outputPath = path.join(outputRoot, blueprint.archiveFilename);
  if (fs.existsSync(outputPath)) {
    throw new Error(`Release artifact already exists: ${outputPath}`);
  }
  const temporaryOutput = path.join(
    outputRoot,
    `.${blueprint.archiveFilename}.partial-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    const inputs = new Map<string, string>();
    for (const input of release.inputs) {
      console.log(`Resolving ${release.packageId} input ${input.fileName}...`);
      inputs.set(input.id, await downloadInput(input, cacheRoot));
    }

    console.log(`Building ${release.packageId}...`);
    packageTreeForRelease(
      release,
      inputs,
      packageWork,
      packageRoot,
    );
    smokePackage(release, packageRoot, packageWork);
    writeToolchainPackageMetadata(packageRoot, release.packageId);
    verifyPackageTree(blueprint, packageRoot);
    archivePackage(packageRoot, temporaryOutput, blueprint.archiveFormat);
    fs.renameSync(temporaryOutput, outputPath);
    console.log(`Packaged ${release.packageId}: ${outputPath}`);
  } finally {
    fs.rmSync(temporaryOutput, { force: true });
    fs.rmSync(packageWork, { recursive: true, force: true });
  }
}

export async function packageHostToolchains(options: {
  outputRoot: string;
  requestedPackageIds?: readonly string[];
  host?: PackagingHost;
  cacheRoot?: string;
}): Promise<void> {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (
    !sourceDateEpoch
    || !/^(0|[1-9][0-9]*)$/.test(sourceDateEpoch)
    || !Number.isSafeInteger(Number(sourceDateEpoch))
    || Number(sourceDateEpoch) > 253_402_300_799
  ) {
    throw new Error("SOURCE_DATE_EPOCH is required for reproducible packaging.");
  }
  const host = options.host ?? resolvePackagingHost();
  const actualHost = resolvePackagingHost();
  if (
    host.platform !== actualHost.platform
    || host.arch !== actualHost.arch
  ) {
    throw new Error("Toolchain packages cannot be cross-built for another host.");
  }
  const selected = selectHostToolchainReleases(
    host,
    options.requestedPackageIds,
  );
  const outputRoot = path.resolve(options.outputRoot);
  const cacheRoot = path.resolve(
    options.cacheRoot
      || process.env.JUDGEDESK_TOOLCHAIN_SOURCE_CACHE
      || path.join("build", "toolchain-source-cache"),
  );
  assertBuildChild(cacheRoot, "Toolchain source cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const operationRoot = path.join(
    path.resolve("build"),
    `toolchain-package-work-${process.pid}-${crypto.randomUUID()}`,
  );
  assertBuildChild(operationRoot, "Toolchain package work root");
  fs.mkdirSync(operationRoot);
  try {
    for (const release of selected) {
      await packageRelease(release, cacheRoot, operationRoot, outputRoot);
    }
  } finally {
    fs.rmSync(operationRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const outputRoot = process.argv[2] || "dist-toolchains";
  const requestedPackageIds = process.argv.slice(3);
  await packageHostToolchains({ outputRoot, requestedPackageIds });
}
