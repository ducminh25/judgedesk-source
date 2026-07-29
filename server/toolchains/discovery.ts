import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  getRegisteredProfileForKind,
  LANGUAGE_REGISTRY_REVISION,
  listRegisteredLanguageProfiles,
} from "../languages/registry.js";
import type { LanguageProfileId } from "../languages/contracts.js";
import { getAppDataDir } from "./storage.js";
import type { ToolchainKind } from "./types.js";

const execFile = promisify(execFileCallback);
const DISCOVERY_SCHEMA_VERSION = 1;
const MAX_DISCOVERY_BYTES = 512 * 1024;
const MAX_CANDIDATES_PER_PROFILE = 64;

export interface DiscoveredToolchainCandidate {
  candidateId: string;
  profileId: LanguageProfileId;
  kind: ToolchainKind;
  canonicalPath: string;
  displayPath: string;
  origin: "path" | "standard-location";
}

export type ToolchainDiscoverySnapshot =
  | {
      schemaVersion: 1;
      registryRevision: number;
      status: "not_started" | "running";
      profiles: Readonly<Record<LanguageProfileId, readonly DiscoveredToolchainCandidate[]>>;
    }
  | {
      schemaVersion: 1;
      registryRevision: number;
      status: "complete";
      completedAt: string;
      profiles: Readonly<Record<LanguageProfileId, readonly DiscoveredToolchainCandidate[]>>;
    }
  | {
      schemaVersion: 1;
      registryRevision: number;
      status: "failed";
      errorCode: "DISCOVERY_STATE_INVALID" | "DISCOVERY_SCAN_FAILED";
      profiles: Readonly<Record<LanguageProfileId, readonly DiscoveredToolchainCandidate[]>>;
    };

interface RuntimeDiscoveryState {
  snapshot: ToolchainDiscoverySnapshot;
  promise?: Promise<ToolchainDiscoverySnapshot>;
}

const runtimeStates = new Map<string, RuntimeDiscoveryState>();

function emptyProfiles(): Record<string, DiscoveredToolchainCandidate[]> {
  return Object.fromEntries(
    listRegisteredLanguageProfiles().map((entry) => [entry.profile.ref.id, []]),
  );
}

export function getToolchainDiscoveryFilePath(): string {
  const directory = getAppDataDir();
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "toolchain-discovery-v1.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAcceptedCandidatePath(candidatePath: string): boolean {
  if (!path.isAbsolute(candidatePath)) return false;
  if (os.platform() !== "win32") return true;
  return !candidatePath.replaceAll("/", "\\").startsWith("\\\\");
}

function parseStoredSnapshot(bytes: Buffer): ToolchainDiscoverySnapshot | null {
  if (bytes.byteLength > MAX_DISCOVERY_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.schemaVersion !== DISCOVERY_SCHEMA_VERSION) return null;
  if (raw.status !== "complete" || typeof raw.completedAt !== "string") return null;
  if (!isRecord(raw.profiles)) return null;

  const profiles: Record<string, DiscoveredToolchainCandidate[]> = emptyProfiles();
  for (const entry of listRegisteredLanguageProfiles()) {
    const profileId = entry.profile.ref.id;
    const candidates = raw.profiles[profileId];
    if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES_PER_PROFILE) {
      return null;
    }
    const parsed: DiscoveredToolchainCandidate[] = [];
    for (const candidate of candidates) {
      if (
        !isRecord(candidate)
        || typeof candidate.candidateId !== "string"
        || candidate.profileId !== profileId
        || candidate.kind !== entry.toolchainKind
        || typeof candidate.canonicalPath !== "string"
        || typeof candidate.displayPath !== "string"
        || (candidate.origin !== "path" && candidate.origin !== "standard-location")
        || !isAcceptedCandidatePath(candidate.canonicalPath)
      ) {
        return null;
      }
      parsed.push(candidate as unknown as DiscoveredToolchainCandidate);
    }
    profiles[profileId] = parsed;
  }
  return {
    schemaVersion: 1,
    registryRevision:
      typeof raw.registryRevision === "number" ? raw.registryRevision : 0,
    status: "complete",
    completedAt: raw.completedAt,
    profiles,
  };
}

function readStoredSnapshot(): ToolchainDiscoverySnapshot {
  const filePath = getToolchainDiscoveryFilePath();
  try {
    const parsed = parseStoredSnapshot(fs.readFileSync(filePath));
    if (parsed) return parsed;
    return {
      schemaVersion: 1,
      registryRevision: LANGUAGE_REGISTRY_REVISION,
      status: "failed",
      errorCode: "DISCOVERY_STATE_INVALID",
      profiles: emptyProfiles(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schemaVersion: 1,
        registryRevision: LANGUAGE_REGISTRY_REVISION,
        status: "not_started",
        profiles: emptyProfiles(),
      };
    }
    return {
      schemaVersion: 1,
      registryRevision: LANGUAGE_REGISTRY_REVISION,
      status: "failed",
      errorCode: "DISCOVERY_STATE_INVALID",
      profiles: emptyProfiles(),
    };
  }
}

function runtimeState(): RuntimeDiscoveryState {
  const filePath = getToolchainDiscoveryFilePath();
  let runtime = runtimeStates.get(filePath);
  if (!runtime) {
    runtime = { snapshot: readStoredSnapshot() };
    runtimeStates.set(filePath, runtime);
  }
  return runtime;
}

export function getToolchainDiscoverySnapshot(): ToolchainDiscoverySnapshot {
  return runtimeState().snapshot;
}

export function getDiscoveredCandidates(
  kind: ToolchainKind,
): readonly DiscoveredToolchainCandidate[] {
  const profileId = getRegisteredProfileForKind(kind).profile.ref.id;
  const snapshot = getToolchainDiscoverySnapshot();
  return snapshot.status === "complete" ? snapshot.profiles[profileId] || [] : [];
}

export function startInitialToolchainDiscovery(): void {
  const runtime = runtimeState();
  if (runtime.snapshot.status === "complete" || runtime.snapshot.status === "failed") {
    return;
  }
  startDiscovery(runtime);
}

export function requestToolchainRescan(): void {
  startDiscovery(runtimeState(), true);
}

export async function waitForToolchainDiscovery(): Promise<ToolchainDiscoverySnapshot> {
  const runtime = runtimeState();
  return runtime.promise || runtime.snapshot;
}

function startDiscovery(runtime: RuntimeDiscoveryState, force = false): void {
  if (runtime.promise) return;
  if (!force && runtime.snapshot.status === "complete") return;
  runtime.snapshot = {
    schemaVersion: 1,
    registryRevision: LANGUAGE_REGISTRY_REVISION,
    status: "running",
    profiles: runtime.snapshot.profiles,
  };
  runtime.promise = Promise.resolve()
    .then(runPassiveDiscovery)
    .then((snapshot) => {
      writeDiscoverySnapshot(snapshot);
      runtime.snapshot = snapshot;
      return snapshot;
    })
    .catch((error) => {
      console.error("[Toolchains] Passive discovery failed:", error);
      const failed: ToolchainDiscoverySnapshot = {
        schemaVersion: 1,
        registryRevision: LANGUAGE_REGISTRY_REVISION,
        status: "failed",
        errorCode: "DISCOVERY_SCAN_FAILED",
        profiles: emptyProfiles(),
      };
      runtime.snapshot = failed;
      return failed;
    })
    .finally(() => {
      runtime.promise = undefined;
    });
}

async function runPassiveDiscovery(): Promise<
  Extract<ToolchainDiscoverySnapshot, { status: "complete" }>
> {
  const profiles: Record<string, DiscoveredToolchainCandidate[]> = emptyProfiles();
  for (const entry of listRegisteredLanguageProfiles()) {
    profiles[entry.profile.ref.id] = await discoverKind(
      entry.profile.ref.id,
      entry.toolchainKind,
    );
  }
  return {
    schemaVersion: 1,
    registryRevision: LANGUAGE_REGISTRY_REVISION,
    status: "complete",
    completedAt: new Date().toISOString(),
    profiles,
  };
}

async function discoverKind(
  profileId: LanguageProfileId,
  kind: ToolchainKind,
): Promise<DiscoveredToolchainCandidate[]> {
  const pathCandidates = collectPathCandidates(kind).map((displayPath) => ({
    displayPath,
    origin: "path" as const,
  }));
  const standardCandidates = (await collectStandardCandidates(kind)).map(
    (displayPath) => ({ displayPath, origin: "standard-location" as const }),
  );
  const seen = new Set<string>();
  const candidates: DiscoveredToolchainCandidate[] = [];
  for (const candidate of [...pathCandidates, ...standardCandidates]) {
    if (candidates.length >= MAX_CANDIDATES_PER_PROFILE) break;
    const canonicalPath = await canonicalExecutablePath(
      candidate.displayPath,
      kind,
    );
    if (!canonicalPath) continue;
    const key = os.platform() === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      candidateId: crypto
        .createHash("sha256")
        .update(`${profileId}\0${canonicalPath}`)
        .digest("hex")
        .slice(0, 24),
      profileId,
      kind,
      canonicalPath,
      displayPath: candidate.displayPath,
      origin: candidate.origin,
    });
  }
  return candidates.sort((left, right) =>
    left.canonicalPath.localeCompare(right.canonicalPath, undefined, {
      sensitivity: os.platform() === "win32" ? "accent" : "variant",
    })
  );
}

function collectPathCandidates(kind: ToolchainKind): string[] {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const environmentPath = (pathKey && process.env[pathKey]) || "";
  const delimiter = os.platform() === "win32" ? ";" : ":";
  const names = kind === "cpp" ? ["g++", "clang++"] : ["python3", "python"];
  const extensions = os.platform() === "win32" ? [".exe"] : [""];
  const candidates: string[] = [];
  for (const directory of environmentPath.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      for (const extension of extensions) {
        candidates.push(path.join(directory, `${name}${extension}`));
      }
    }
  }
  return candidates;
}

async function collectStandardCandidates(kind: ToolchainKind): Promise<string[]> {
  if (os.platform() === "win32") return collectWindowsCandidates(kind);
  if (os.platform() === "darwin") return collectDarwinCandidates(kind);
  return kind === "cpp"
    ? ["/usr/bin/g++", "/usr/bin/clang++", "/usr/local/bin/g++"]
    : ["/usr/bin/python3", "/usr/local/bin/python3"];
}

async function collectWindowsCandidates(kind: ToolchainKind): Promise<string[]> {
  const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const programFilesX86 = process.env["ProgramFiles(x86)"]
    || String.raw`C:\Program Files (x86)`;
  const localAppData = process.env.LOCALAPPDATA
    || path.join(os.homedir(), "AppData", "Local");
  const userProfile = process.env.USERPROFILE || os.homedir();
  if (kind === "cpp") {
    return [
      path.join(programFiles, "Themis", "GCC", "bin", "g++.exe"),
      path.join(programFilesX86, "Themis", "GCC", "bin", "g++.exe"),
      String.raw`C:\Themis\GCC\bin\g++.exe`,
      String.raw`C:\msys64\ucrt64\bin\g++.exe`,
      String.raw`C:\msys64\mingw64\bin\g++.exe`,
      path.join(programFiles, "CodeBlocks", "MinGW", "bin", "g++.exe"),
      path.join(programFilesX86, "CodeBlocks", "MinGW", "bin", "g++.exe"),
      path.join(localAppData, "Programs", "CodeBlocks", "MinGW", "bin", "g++.exe"),
      String.raw`C:\MinGW\bin\g++.exe`,
      path.join(userProfile, "scoop", "apps", "gcc", "current", "bin", "g++.exe"),
    ];
  }

  const candidates = [
    String.raw`C:\Python313\python.exe`,
    String.raw`C:\Python312\python.exe`,
    String.raw`C:\Python311\python.exe`,
    String.raw`C:\Python310\python.exe`,
    path.join(userProfile, "scoop", "apps", "python", "current", "python.exe"),
  ];
  const pythonRoot = path.join(localAppData, "Programs", "Python");
  for (const child of await listImmediateDirectories(pythonRoot)) {
    candidates.push(path.join(child, "python.exe"));
  }
  return candidates;
}

async function collectDarwinCandidates(kind: ToolchainKind): Promise<string[]> {
  if (kind === "cpp") {
    const candidates: string[] = [];
    try {
      // xcrun resolves the compiler belonging to the currently selected
      // Developer root. Do not add inactive Xcode/CLT installations beside
      // it: those are genuinely different toolchains and made every normal
      // Mac look ambiguous merely because both roots happened to be present.
      const { stdout } = await execFile("/usr/bin/xcrun", ["--find", "clang++"], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 16 * 1024,
      });
      const selectedCompiler = stdout.trim();
      if (selectedCompiler) candidates.push(selectedCompiler);
    } catch {
      // Command Line Tools are optional and absence is represented by no candidate.
    }
    candidates.push(
      "/opt/homebrew/bin/clang++",
      "/opt/homebrew/bin/g++",
      "/usr/local/bin/clang++",
      "/usr/local/bin/g++",
    );
    return candidates;
  }

  const candidates = [
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "/opt/local/bin/python3",
  ];
  for (const child of await listImmediateDirectories(
    "/Library/Frameworks/Python.framework/Versions",
  )) {
    candidates.push(path.join(child, "bin", "python3"));
  }
  return candidates;
}

async function listImmediateDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function canonicalExecutablePath(
  candidatePath: string,
  kind: ToolchainKind,
): Promise<string | null> {
  // Never let a PATH entry turn first-run discovery into network I/O.
  if (!isAcceptedCandidatePath(candidatePath)) return null;
  try {
    const canonicalPath = await fs.promises.realpath(candidatePath);
    if (
      os.platform() === "darwin"
      && kind === "cpp"
      && (canonicalPath === "/usr/bin/clang++" || canonicalPath === "/usr/bin/g++")
    ) {
      // These are Apple driver stubs, not a pinned compiler identity. The
      // selected platform compiler is represented by xcrun's resolved path.
      return null;
    }
    const metadata = await fs.promises.stat(canonicalPath);
    if (!metadata.isFile()) return null;
    if (os.platform() !== "win32" && (metadata.mode & 0o111) === 0) return null;
    return canonicalPath;
  } catch {
    return null;
  }
}

function writeDiscoverySnapshot(
  snapshot: Extract<ToolchainDiscoverySnapshot, { status: "complete" }>,
): void {
  const filePath = getToolchainDiscoveryFilePath();
  const canonicalJson = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_DISCOVERY_BYTES) {
    throw new Error("Toolchain discovery result exceeds its storage limit.");
  }
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, canonicalJson, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function resetToolchainDiscoveryRuntimeForTests(): void {
  runtimeStates.clear();
}
