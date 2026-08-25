import crypto from "node:crypto";
import {
  execFile as execFileCallback,
  type ChildProcess,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getRegisteredProfileForKind,
  LANGUAGE_REGISTRY_REVISION,
  listRegisteredLanguageProfiles,
} from "../languages/registry.js";
import type { LanguageProfileId } from "../languages/contracts.js";
import { getStoredProfilePreference } from "./preferences-v2.js";
import {
  getAppDataDir,
  loadToolchainPreferenceSnapshot,
} from "./storage.js";
import type { ToolchainKind } from "./types.js";

const DISCOVERY_SCHEMA_VERSION = 2;
const MAX_DISCOVERY_BYTES = 512 * 1024;
const MAX_CANDIDATES_PER_PROFILE = 64;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 320;
const COMMAND_TIMEOUT_MS = 700;
const DISCOVERY_DEADLINE_MS = 1_450;

export interface DiscoveredToolchainCandidate {
  candidateId: string;
  profileId: LanguageProfileId;
  kind: ToolchainKind;
  canonicalPath: string;
  displayPath: string;
  origin: "path" | "standard-location" | "selected-path";
  /** Zero-based directory position in PATH; null for non-PATH candidates. */
  pathRank: number | null;
  family: string | null;
  version: string | null;
  target: string | null;
  lastSeenAt: string;
  /** A short probe error. Null means the version command succeeded. */
  error: string | null;
}

type DiscoveryProfiles = Readonly<
  Record<LanguageProfileId, readonly DiscoveredToolchainCandidate[]>
>;

export type ToolchainDiscoverySnapshot =
  | {
      schemaVersion: 2;
      registryRevision: number;
      status: "not_started";
      refreshing: false;
      profiles: DiscoveryProfiles;
    }
  | {
      schemaVersion: 2;
      registryRevision: number;
      status: "running";
      refreshing: true;
      startedAt: string;
      profiles: DiscoveryProfiles;
    }
  | {
      schemaVersion: 2;
      registryRevision: number;
      status: "complete";
      refreshing: boolean;
      completedAt: string;
      startedAt?: string;
      profiles: DiscoveryProfiles;
    }
  | {
      schemaVersion: 2;
      registryRevision: number;
      status: "failed";
      refreshing: false;
      checkedAt: string;
      errorCode: "DISCOVERY_STATE_INVALID" | "DISCOVERY_SCAN_FAILED";
      profiles: DiscoveryProfiles;
    };

export interface ToolchainVersionProbeRequest {
  kind: ToolchainKind;
  executablePath: string;
  args: readonly string[];
  timeoutMs: number;
}

export interface ToolchainVersionProbeOutput {
  stdout: string;
  stderr: string;
}

type ToolchainVersionProbe = (
  request: ToolchainVersionProbeRequest,
) => Promise<ToolchainVersionProbeOutput>;

type StandardCandidateProvider = (
  kind: ToolchainKind,
  deadlineAt: number,
) => Promise<readonly string[]>;

interface RuntimeDiscoveryState {
  snapshot: ToolchainDiscoverySnapshot;
  promise?: Promise<ToolchainDiscoverySnapshot>;
  initialRefreshStarted: boolean;
  rescanRequested: boolean;
}

interface CandidateLocation {
  displayPath: string;
  origin: "path" | "standard-location" | "selected-path";
  pathRank: number | null;
}

interface ParsedVersion {
  family: string;
  version: string;
  target: string | null;
}

const runtimeStates = new Map<string, RuntimeDiscoveryState>();
const activeDiscoveryChildren = new Set<ChildProcess>();
let testProbe: ToolchainVersionProbe | undefined;
let testStandardCandidates: StandardCandidateProvider | undefined;

function emptyProfiles(): Record<string, DiscoveredToolchainCandidate[]> {
  return Object.fromEntries(
    listRegisteredLanguageProfiles().map((entry) => [entry.profile.ref.id, []]),
  );
}

export function getToolchainDiscoveryFilePath(): string {
  const directory = getAppDataDir();
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "toolchain-discovery-v2.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAcceptedCandidatePath(candidatePath: string): boolean {
  if (!path.isAbsolute(candidatePath)) return false;
  if (os.platform() !== "win32") return true;
  const windowsPath = candidatePath.replaceAll("/", "\\");
  return !windowsPath.startsWith("\\\\") && !windowsPath.startsWith("\\?\\");
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function isNullableBoundedString(
  value: unknown,
  maximumLength: number,
): value is string | null {
  return value === null
    || (typeof value === "string" && value.length > 0 && value.length <= maximumLength);
}

function parseStoredCandidate(
  value: unknown,
  profileId: LanguageProfileId,
  kind: ToolchainKind,
): DiscoveredToolchainCandidate | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.candidateId !== "string"
    || !/^[a-f0-9]{24}$/.test(value.candidateId)
    || value.profileId !== profileId
    || value.kind !== kind
    || typeof value.canonicalPath !== "string"
    || typeof value.displayPath !== "string"
    || value.displayPath.length === 0
    || value.displayPath.length > 32_768
    || !isAcceptedCandidatePath(value.canonicalPath)
    || (
      value.origin !== "path"
      && value.origin !== "standard-location"
      && value.origin !== "selected-path"
    )
    || !isNullableBoundedString(value.family, 64)
    || !isNullableBoundedString(value.version, 128)
    || !isNullableBoundedString(value.target, 256)
    || !isTimestamp(value.lastSeenAt)
    || !isNullableBoundedString(value.error, MAX_ERROR_LENGTH)
  ) {
    return null;
  }
  const pathRank = value.pathRank;
  if (value.origin === "path") {
    if (
      typeof pathRank !== "number"
      || !Number.isSafeInteger(pathRank)
      || pathRank < 0
      || pathRank > 16_384
    ) {
      return null;
    }
  } else if (pathRank !== null) {
    return null;
  }
  const successful = value.error === null;
  if (successful !== (value.family !== null && value.version !== null)) {
    return null;
  }
  return value as unknown as DiscoveredToolchainCandidate;
}

function parseStoredSnapshot(bytes: Buffer): ToolchainDiscoverySnapshot | null {
  if (bytes.byteLength > MAX_DISCOVERY_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(raw)
    || raw.schemaVersion !== DISCOVERY_SCHEMA_VERSION
    || raw.status !== "complete"
    || raw.refreshing !== false
    || !isTimestamp(raw.completedAt)
    || !isRecord(raw.profiles)
  ) {
    return null;
  }
  const registryRevision = raw.registryRevision;
  if (
    typeof registryRevision !== "number"
    || !Number.isSafeInteger(registryRevision)
    || registryRevision < 1
    || registryRevision > LANGUAGE_REGISTRY_REVISION
  ) {
    return null;
  }
  const staleRegistry = registryRevision < LANGUAGE_REGISTRY_REVISION;
  const profiles: Record<string, DiscoveredToolchainCandidate[]> = emptyProfiles();
  for (const entry of listRegisteredLanguageProfiles()) {
    const profileId = entry.profile.ref.id;
    const candidates = raw.profiles[profileId];
    if (candidates === undefined && staleRegistry) continue;
    if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES_PER_PROFILE) {
      return null;
    }
    const parsed: DiscoveredToolchainCandidate[] = [];
    const ids = new Set<string>();
    for (const value of candidates) {
      const candidate = parseStoredCandidate(value, profileId, entry.toolchainKind);
      if (!candidate || ids.has(candidate.candidateId)) return null;
      ids.add(candidate.candidateId);
      parsed.push(candidate);
    }
    profiles[profileId] = parsed;
  }
  return {
    schemaVersion: 2,
    registryRevision,
    status: "complete",
    refreshing: false,
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
      schemaVersion: 2,
      registryRevision: LANGUAGE_REGISTRY_REVISION,
      status: "failed",
      refreshing: false,
      checkedAt: new Date().toISOString(),
      errorCode: "DISCOVERY_STATE_INVALID",
      profiles: emptyProfiles(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schemaVersion: 2,
        registryRevision: LANGUAGE_REGISTRY_REVISION,
        status: "not_started",
        refreshing: false,
        profiles: emptyProfiles(),
      };
    }
    return {
      schemaVersion: 2,
      registryRevision: LANGUAGE_REGISTRY_REVISION,
      status: "failed",
      refreshing: false,
      checkedAt: new Date().toISOString(),
      errorCode: "DISCOVERY_STATE_INVALID",
      profiles: emptyProfiles(),
    };
  }
}

function runtimeState(): RuntimeDiscoveryState {
  const filePath = getToolchainDiscoveryFilePath();
  let runtime = runtimeStates.get(filePath);
  if (!runtime) {
    runtime = {
      snapshot: readStoredSnapshot(),
      initialRefreshStarted: false,
      rescanRequested: false,
    };
    runtimeStates.set(filePath, runtime);
  }
  return runtime;
}

export function getToolchainDiscoverySnapshot(): ToolchainDiscoverySnapshot {
  return runtimeState().snapshot;
}

export function isSuccessfulDiscoveredCandidate(
  candidate: DiscoveredToolchainCandidate,
): boolean {
  return candidate.error === null
    && candidate.family !== null
    && candidate.version !== null;
}

/**
 * Returns only executable candidates whose non-shell version probe succeeded.
 * Discovery is deterministic, so at most one successful candidate is retained
 * for each profile. Failed attempts remain available in the full snapshot.
 */
export function getDiscoveredCandidates(
  kind: ToolchainKind,
): readonly DiscoveredToolchainCandidate[] {
  const profileId = getRegisteredProfileForKind(kind).profile.ref.id;
  return (getToolchainDiscoverySnapshot().profiles[profileId] || []).filter(
    isSuccessfulDiscoveredCandidate,
  );
}

export function getToolchainDiscoveryAttempts(
  kind: ToolchainKind,
): readonly DiscoveredToolchainCandidate[] {
  const profileId = getRegisteredProfileForKind(kind).profile.ref.id;
  return getToolchainDiscoverySnapshot().profiles[profileId] || [];
}

export function startInitialToolchainDiscovery(): void {
  const runtime = runtimeState();
  if (runtime.initialRefreshStarted) return;
  runtime.initialRefreshStarted = true;
  startDiscovery(runtime);
}

export function requestToolchainRescan(): void {
  const runtime = runtimeState();
  if (runtime.promise) {
    runtime.rescanRequested = true;
    return;
  }
  startDiscovery(runtime);
}

export async function waitForToolchainDiscovery(): Promise<ToolchainDiscoverySnapshot> {
  const runtime = runtimeState();
  return runtime.promise || runtime.snapshot;
}

function startDiscovery(runtime: RuntimeDiscoveryState): void {
  if (runtime.promise) return;
  const startedAt = new Date().toISOString();
  const cached = runtime.snapshot;
  if (cached.status === "complete") {
    runtime.snapshot = {
      ...cached,
      refreshing: true,
      startedAt,
    };
  } else {
    runtime.snapshot = {
      schemaVersion: 2,
      registryRevision: LANGUAGE_REGISTRY_REVISION,
      status: "running",
      refreshing: true,
      startedAt,
      profiles: cached.profiles,
    };
  }
  const retainedProfiles = runtime.snapshot.profiles;
  runtime.promise = Promise.resolve()
    .then(() => runDiscovery(retainedProfiles))
    .then((snapshot) => {
      writeDiscoverySnapshot(snapshot);
      runtime.snapshot = snapshot;
      return snapshot;
    })
    .catch((error) => {
      console.error("[Toolchains] Background discovery failed:", error);
      const failed: ToolchainDiscoverySnapshot = {
        schemaVersion: 2,
        registryRevision: LANGUAGE_REGISTRY_REVISION,
        status: "failed",
        refreshing: false,
        checkedAt: new Date().toISOString(),
        errorCode: "DISCOVERY_SCAN_FAILED",
        profiles: retainedProfiles,
      };
      runtime.snapshot = failed;
      return failed;
    })
    .finally(() => {
      runtime.promise = undefined;
      if (runtime.rescanRequested) {
        runtime.rescanRequested = false;
        startDiscovery(runtime);
      }
    });
}

async function runDiscovery(
  previousProfiles: DiscoveryProfiles,
): Promise<Extract<ToolchainDiscoverySnapshot, { status: "complete" }>> {
  const profiles: Record<string, DiscoveredToolchainCandidate[]> = emptyProfiles();
  const deadlineAt = Date.now() + DISCOVERY_DEADLINE_MS;
  await Promise.all(listRegisteredLanguageProfiles().map(async (entry) => {
    const profileId = entry.profile.ref.id;
    try {
      profiles[profileId] = await discoverKind(
        profileId,
        entry.toolchainKind,
        deadlineAt,
      );
    } catch (error) {
      console.error(`[Toolchains] Discovery failed for ${entry.toolchainKind}:`, error);
      profiles[profileId] = [...(previousProfiles[profileId] || [])];
    }
  }));
  return {
    schemaVersion: 2,
    registryRevision: LANGUAGE_REGISTRY_REVISION,
    status: "complete",
    refreshing: false,
    completedAt: new Date().toISOString(),
    profiles,
  };
}

async function discoverKind(
  profileId: LanguageProfileId,
  kind: ToolchainKind,
  deadlineAt: number,
): Promise<DiscoveredToolchainCandidate[]> {
  const attempts: DiscoveredToolchainCandidate[] = [];
  const seen = new Set<string>();
  const selectedLocation = selectedLocalPathLocation(kind);
  if (selectedLocation) {
    const selectedResult = await probeLocations(
      profileId,
      kind,
      [selectedLocation],
      attempts,
      seen,
      deadlineAt,
    );
    if (selectedResult || Date.now() >= deadlineAt) return attempts;
  }
  const pathLocations = collectPathCandidates(kind);
  const pathResult = await probeLocations(
    profileId,
    kind,
    pathLocations,
    attempts,
    seen,
    deadlineAt,
  );
  if (pathResult || Date.now() >= deadlineAt) return attempts;

  const provider = testStandardCandidates || collectStandardCandidates;
  const standardPaths = await withinDeadline(
    provider(kind, deadlineAt),
    deadlineAt,
    "standard_location_timeout",
  ).catch(() => [] as readonly string[]);
  const standardLocations = standardPaths.map((displayPath) => ({
    displayPath,
    origin: "standard-location" as const,
    pathRank: null,
  }));
  await probeLocations(
    profileId,
    kind,
    standardLocations,
    attempts,
    seen,
    deadlineAt,
  );
  return attempts;
}

function selectedLocalPathLocation(
  kind: ToolchainKind,
): CandidateLocation | null {
  const snapshot = loadToolchainPreferenceSnapshot();
  if (snapshot.status === "recovery") return null;
  const profileId = getRegisteredProfileForKind(kind).profile.ref.id;
  const selection = getStoredProfilePreference(
    snapshot.preferences,
    profileId,
  );
  if (selection.mode !== "local_path" || !selection.localPath) return null;
  return {
    displayPath: selection.localPath,
    origin: "selected-path",
    pathRank: null,
  };
}

async function probeLocations(
  profileId: LanguageProfileId,
  kind: ToolchainKind,
  locations: readonly CandidateLocation[],
  attempts: DiscoveredToolchainCandidate[],
  seen: Set<string>,
  deadlineAt: number,
): Promise<boolean> {
  for (const location of locations) {
    if (
      attempts.length >= MAX_CANDIDATES_PER_PROFILE
      || Date.now() >= deadlineAt
    ) {
      return false;
    }
    const canonicalPath = await canonicalExecutablePath(
      location.displayPath,
      kind,
      deadlineAt,
    );
    if (!canonicalPath) continue;
    const key = os.platform() === "win32"
      ? canonicalPath.toLowerCase()
      : canonicalPath;
    if (seen.has(key)) continue;
    seen.add(key);

    const candidate = await probeCandidate(
      profileId,
      kind,
      canonicalPath,
      location,
      deadlineAt,
    );
    attempts.push(candidate);
    if (
      candidate.error === null
      && candidate.family !== null
      && candidate.version !== null
    ) {
      return true;
    }
  }
  return false;
}

async function probeCandidate(
  profileId: LanguageProfileId,
  kind: ToolchainKind,
  canonicalPath: string,
  location: CandidateLocation,
  deadlineAt: number,
): Promise<DiscoveredToolchainCandidate> {
  const lastSeenAt = new Date().toISOString();
  const base = {
    candidateId: crypto
      .createHash("sha256")
      .update(`${profileId}\0${canonicalPath}`)
      .digest("hex")
      .slice(0, 24),
    profileId,
    kind,
    canonicalPath,
    displayPath: location.displayPath,
    origin: location.origin,
    pathRank: location.pathRank,
    lastSeenAt,
  } as const;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    return {
      ...base,
      family: null,
      version: null,
      target: null,
      error: "probe_deadline_exceeded",
    };
  }
  const timeoutMs = Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remaining));
  try {
    const probe = testProbe || runVersionCommand;
    const output = await withTimeout(
      probe({
        kind,
        executablePath: canonicalPath,
        args: versionArgsForKind(kind),
        timeoutMs,
      }),
      timeoutMs,
      "probe_timeout",
    );
    const parsed = parseVersionOutput(kind, `${output.stdout}\n${output.stderr}`);
    if (!parsed) {
      return {
        ...base,
        family: null,
        version: null,
        target: null,
        error: "version_unrecognized",
      };
    }
    const successful: DiscoveredToolchainCandidate = {
      ...base,
      family: parsed.family.slice(0, 64),
      version: parsed.version.slice(0, 128),
      target: parsed.target?.trim().slice(0, 256) || null,
      error: null,
    };
    scheduleCompatibilityProbe(kind, canonicalPath);
    return successful;
  } catch (error) {
    return {
      ...base,
      family: null,
      version: null,
      target: null,
      error: shortProbeError(error),
    };
  }
}

function scheduleCompatibilityProbe(
  kind: ToolchainKind,
  executablePath: string,
): void {
  if (testProbe || (kind !== "cpp" && kind !== "c" && kind !== "python")) {
    return;
  }
  // The native-executor probe has its own longer lifecycle and must never
  // extend the 1.45 s discovery deadline. Dynamic import also keeps cache reads
  // free of the executor/job dependency graph.
  void import("./local-execution.js")
    .then(({ scheduleLocalCompatibilityProbe }) =>
      scheduleLocalCompatibilityProbe(kind, executablePath)
    )
    .catch((error) => {
      console.error(`[Toolchains] Local compatibility probe failed to start for ${kind}:`, error);
    });
}

function versionArgsForKind(kind: ToolchainKind): readonly string[] {
  const args: Record<ToolchainKind, readonly string[]> = {
    cpp: ["-v"],
    c: ["-v"],
    python: ["--version"],
    pascal: ["-iV"],
    go: ["version"],
    java: ["-version"],
    rust: ["-vV"],
    javascript: ["--version"],
    csharp: ["--version"],
  };
  return args[kind];
}

function parseVersionOutput(
  kind: ToolchainKind,
  rawOutput: string,
): ParsedVersion | null {
  const output = rawOutput.replaceAll("\0", "").trim();
  if (!output) return null;
  const first = (...patterns: readonly RegExp[]): string | null => {
    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match?.[1]) return match[1];
    }
    return null;
  };
  if (kind === "cpp" || kind === "c") {
    const lower = output.toLowerCase();
    const family = lower.includes("apple clang")
      ? "apple-clang"
      : lower.includes("clang")
        ? "llvm-clang"
        : lower.includes("gcc") || lower.includes("g++")
          ? "gnu-gcc"
          : null;
    const version = first(
      /Apple clang version\s+([^\s]+)/i,
      /clang version\s+([^\s]+)/i,
      /gcc version\s+([^\s]+)/i,
      /(?:gcc|g\+\+)[^\r\n]*?\s(\d+(?:\.\d+){1,3}(?:[-+][^\s)]+)?)/i,
    );
    if (!family || !version) return null;
    return {
      family,
      version,
      target: first(/^Target:\s*([^\r\n]+)$/im),
    };
  }
  if (kind === "python") {
    const version = first(/Python\s+([^\s]+)/i);
    return version ? { family: "cpython", version, target: null } : null;
  }
  if (kind === "pascal") {
    const version = first(/^\s*(\d+(?:\.\d+){1,3})\s*$/m, /version\s+(\d+(?:\.\d+){1,3})/i);
    return version ? { family: "free-pascal", version, target: null } : null;
  }
  if (kind === "go") {
    const match = output.match(/go version go([^\s]+)\s+([^\s]+)/i);
    return match ? { family: "go", version: match[1], target: match[2] } : null;
  }
  if (kind === "java") {
    const version = first(/(?:javac|openjdk|java)\s+(?:version\s+)?"?([^\s"]+)/i);
    return version ? { family: "java", version, target: null } : null;
  }
  if (kind === "rust") {
    const version = first(/^rustc\s+([^\s]+)/im);
    return version
      ? { family: "rust", version, target: first(/^host:\s*([^\r\n]+)$/im) }
      : null;
  }
  if (kind === "javascript") {
    const version = first(/^v?(\d+(?:\.\d+){1,3}(?:[-+][^\s]+)?)\s*$/im);
    return version ? { family: "nodejs", version, target: null } : null;
  }
  const version = first(/^(\d+(?:\.\d+){1,3}(?:[-+][^\s]+)?)\s*$/im);
  return version ? { family: "dotnet-sdk", version, target: null } : null;
}

function shortProbeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || "probe_failed").slice(0, MAX_ERROR_LENGTH);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function withinDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  errorMessage: string,
): Promise<T> {
  return withTimeout(promise, Math.max(1, deadlineAt - Date.now()), errorMessage);
}

function runVersionCommand(
  request: ToolchainVersionProbeRequest,
): Promise<ToolchainVersionProbeOutput> {
  return execFileText(
    request.executablePath,
    request.args,
    request.timeoutMs,
  );
}

function execFileText(
  executablePath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ToolchainVersionProbeOutput> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      executablePath,
      [...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        activeDiscoveryChildren.delete(child);
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    activeDiscoveryChildren.add(child);
    child.once("exit", () => activeDiscoveryChildren.delete(child));
    child.once("error", () => activeDiscoveryChildren.delete(child));
  });
}

function collectPathCandidates(kind: ToolchainKind): CandidateLocation[] {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const environmentPath = (pathKey && process.env[pathKey]) || "";
  const delimiter = os.platform() === "win32" ? ";" : ":";
  const names = executableNamesForKind(kind);
  const extensions = os.platform() === "win32" ? [".exe"] : [""];
  const candidates: CandidateLocation[] = [];
  for (const [pathRank, rawDirectory] of environmentPath.split(delimiter).entries()) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const name of names) {
      for (const extension of extensions) {
        candidates.push({
          displayPath: path.join(directory, `${name}${extension}`),
          origin: "path",
          pathRank,
        });
      }
    }
  }
  return candidates;
}

async function collectStandardCandidates(
  kind: ToolchainKind,
  deadlineAt: number,
): Promise<string[]> {
  if (os.platform() === "win32") return collectWindowsCandidates(kind, deadlineAt);
  if (os.platform() === "darwin") return collectDarwinCandidates(kind, deadlineAt);
  return executableNamesForKind(kind).flatMap((name) => [
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
  ]);
}

async function collectWindowsCandidates(
  kind: ToolchainKind,
  deadlineAt: number,
): Promise<string[]> {
  const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const programFilesX86 = process.env["ProgramFiles(x86)"]
    || String.raw`C:\Program Files (x86)`;
  const localAppData = process.env.LOCALAPPDATA
    || path.join(os.homedir(), "AppData", "Local");
  const userProfile = process.env.USERPROFILE || os.homedir();
  if (kind === "cpp" || kind === "c") {
    const executable = kind === "cpp" ? "g++.exe" : "gcc.exe";
    return [
      path.join(String.raw`C:\msys64\ucrt64\bin`, executable),
      path.join(String.raw`C:\msys64\mingw64\bin`, executable),
      path.join(programFiles, "Themis", "GCC", "bin", executable),
      path.join(programFilesX86, "Themis", "GCC", "bin", executable),
      path.join(String.raw`C:\Themis\GCC\bin`, executable),
      path.join(programFiles, "CodeBlocks", "MinGW", "bin", executable),
      path.join(programFilesX86, "CodeBlocks", "MinGW", "bin", executable),
      path.join(localAppData, "Programs", "CodeBlocks", "MinGW", "bin", executable),
      path.join(String.raw`C:\MinGW\bin`, executable),
      path.join(userProfile, "scoop", "apps", "gcc", "current", "bin", executable),
    ];
  }
  if (kind === "python") {
    const candidates = [
      path.join(programFiles, "Themis", "Python", "python.exe"),
      path.join(programFilesX86, "Themis", "Python", "python.exe"),
      String.raw`C:\Themis\Python\python.exe`,
      String.raw`C:\Python313\python.exe`,
      String.raw`C:\Python312\python.exe`,
      String.raw`C:\Python311\python.exe`,
      String.raw`C:\Python310\python.exe`,
      path.join(userProfile, "scoop", "apps", "python", "current", "python.exe"),
    ];
    const pythonRoot = path.join(localAppData, "Programs", "Python");
    for (const child of await listImmediateDirectories(pythonRoot, deadlineAt)) {
      candidates.push(path.join(child, "python.exe"));
    }
    return candidates;
  }
  const configuredHome = configuredToolchainHome(kind);
  if (kind === "java") {
    const candidates: string[] = [
      path.join(programFiles, "Themis", "Java", "bin", "javac.exe"),
      path.join(programFilesX86, "Themis", "Java", "bin", "javac.exe"),
      String.raw`C:\Themis\Java\bin\javac.exe`,
    ];
    if (configuredHome) candidates.push(path.join(configuredHome, "bin", "javac.exe"));
    for (const vendorRoot of [
      path.join(programFiles, "Eclipse Adoptium"),
      path.join(programFiles, "Java"),
      path.join(programFiles, "Microsoft"),
    ]) {
      for (const child of await listImmediateDirectories(vendorRoot, deadlineAt)) {
        candidates.push(path.join(child, "bin", "javac.exe"));
      }
    }
    return candidates;
  }
  const standard: Record<
    Exclude<ToolchainKind, "cpp" | "c" | "python" | "java">,
    string[]
  > = {
    pascal: [
      path.join(programFiles, "Themis", "fpc", "bin", "i386-win32", "fpc.exe"),
      path.join(programFilesX86, "Themis", "fpc", "bin", "i386-win32", "fpc.exe"),
      String.raw`C:\Themis\fpc\bin\i386-win32\fpc.exe`,
      String.raw`C:\FPC\3.2.2\bin\x86_64-win64\fpc.exe`,
      String.raw`C:\FPC\3.2.2\bin\i386-win32\fpc.exe`,
      String.raw`C:\lazarus\fpc\3.2.2\bin\x86_64-win64\fpc.exe`,
    ],
    go: [
      path.join(programFiles, "Go", "bin", "go.exe"),
      path.join(userProfile, "scoop", "apps", "go", "current", "bin", "go.exe"),
    ],
    rust: [
      path.join(userProfile, ".cargo", "bin", "rustc.exe"),
      path.join(userProfile, "scoop", "apps", "rustup", "current", ".cargo", "bin", "rustc.exe"),
    ],
    javascript: [
      path.join(programFiles, "nodejs", "node.exe"),
      path.join(userProfile, ".volta", "bin", "node.exe"),
      path.join(programFiles, "Volta", "node.exe"),
    ],
    csharp: [
      path.join(configuredHome || programFiles, "dotnet.exe"),
      path.join(programFiles, "dotnet", "dotnet.exe"),
    ],
  };
  return standard[kind];
}

async function collectDarwinCandidates(
  kind: ToolchainKind,
  deadlineAt: number,
): Promise<string[]> {
  if (kind === "cpp" || kind === "c") {
    const candidates: string[] = [];
    const compilerName = kind === "cpp" ? "clang++" : "clang";
    const remaining = deadlineAt - Date.now();
    if (remaining > 0) {
      try {
        const output = await execFileText(
          "/usr/bin/xcrun",
          ["--find", compilerName],
          Math.min(COMMAND_TIMEOUT_MS, remaining),
        );
        const selectedCompiler = output.stdout.trim();
        if (selectedCompiler) candidates.push(selectedCompiler);
      } catch {
        // Command Line Tools are optional.
      }
    }
    candidates.push(
      ...(kind === "cpp"
        ? [
            "/Library/Developer/CommandLineTools/usr/bin/clang++",
            "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++",
            "/Applications/Xcode.app/Contents/Developer/usr/bin/clang++",
            "/opt/homebrew/bin/clang++",
            "/opt/homebrew/bin/g++",
            "/usr/local/bin/clang++",
            "/usr/local/bin/g++",
          ]
        : [
            "/Library/Developer/CommandLineTools/usr/bin/clang",
            "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
            "/Applications/Xcode.app/Contents/Developer/usr/bin/clang",
            "/opt/homebrew/bin/clang",
            "/opt/homebrew/bin/gcc",
            "/usr/local/bin/clang",
            "/usr/local/bin/gcc",
          ]),
    );
    return candidates;
  }
  if (kind === "python") {
    const candidates = [
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
      "/opt/local/bin/python3",
    ];
    for (const child of await listImmediateDirectories(
      "/Library/Frameworks/Python.framework/Versions",
      deadlineAt,
    )) {
      candidates.push(path.join(child, "bin", "python3"));
    }
    return candidates;
  }
  const home = os.homedir();
  const configuredHome = configuredToolchainHome(kind);
  if (kind === "java") {
    const candidates = [
      "/opt/homebrew/opt/openjdk@21/bin/javac",
      "/usr/local/opt/openjdk@21/bin/javac",
      "/usr/bin/javac",
    ];
    if (configuredHome) candidates.unshift(path.join(configuredHome, "bin", "javac"));
    for (const bundle of await listImmediateDirectories(
      "/Library/Java/JavaVirtualMachines",
      deadlineAt,
    )) {
      candidates.push(path.join(bundle, "Contents", "Home", "bin", "javac"));
    }
    return candidates;
  }
  const standard: Record<
    Exclude<ToolchainKind, "cpp" | "c" | "python" | "java">,
    string[]
  > = {
    pascal: ["/opt/homebrew/bin/fpc", "/usr/local/bin/fpc", "/opt/local/bin/fpc"],
    go: ["/usr/local/go/bin/go", "/opt/homebrew/bin/go", "/usr/local/bin/go"],
    rust: [path.join(home, ".cargo", "bin", "rustc"), "/opt/homebrew/bin/rustc", "/usr/local/bin/rustc"],
    javascript: [path.join(home, ".volta", "bin", "node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"],
    csharp: [
      path.join(configuredHome || "/usr/local/share/dotnet", "dotnet"),
      "/opt/homebrew/bin/dotnet",
      "/usr/local/bin/dotnet",
    ],
  };
  return standard[kind];
}

function executableNamesForKind(kind: ToolchainKind): readonly string[] {
  const names: Record<ToolchainKind, readonly string[]> = {
    cpp: ["g++", "clang++"],
    c: ["gcc", "clang"],
    python: ["python3", "python"],
    pascal: ["fpc"],
    go: ["go"],
    java: ["javac"],
    rust: ["rustc"],
    javascript: ["node"],
    csharp: ["dotnet"],
  };
  return names[kind];
}

function configuredToolchainHome(kind: ToolchainKind): string | undefined {
  if (kind === "java") return process.env.JAVA_HOME;
  if (kind === "go") return process.env.GOROOT;
  if (kind === "csharp") return process.env.DOTNET_ROOT;
  return undefined;
}

async function listImmediateDirectories(
  root: string,
  deadlineAt: number,
): Promise<string[]> {
  if (Date.now() >= deadlineAt || !isAcceptedCandidatePath(root)) return [];
  try {
    const entries = await withinDeadline(
      fs.promises.readdir(root, { withFileTypes: true }),
      deadlineAt,
      "directory_scan_timeout",
    );
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
  deadlineAt: number,
): Promise<string | null> {
  if (!isAcceptedCandidatePath(candidatePath) || Date.now() >= deadlineAt) return null;
  try {
    const canonicalPath = await withinDeadline(
      fs.promises.realpath(candidatePath),
      deadlineAt,
      "path_resolution_timeout",
    );
    if (
      os.platform() === "darwin"
      && (kind === "cpp" || kind === "c")
      && [
        "/usr/bin/clang++",
        "/usr/bin/g++",
        "/usr/bin/clang",
        "/usr/bin/gcc",
      ].includes(canonicalPath)
    ) {
      return null;
    }
    const metadata = await withinDeadline(
      fs.promises.stat(canonicalPath),
      deadlineAt,
      "path_stat_timeout",
    );
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
  const persisted = { ...snapshot, refreshing: false, startedAt: undefined };
  const filePath = getToolchainDiscoveryFilePath();
  const canonicalJson = `${JSON.stringify(persisted, null, 2)}\n`;
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

/** Stops in-flight discovery processes during application shutdown. */
export function cancelToolchainDiscovery(): void {
  for (const child of activeDiscoveryChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between enumeration and kill.
    }
  }
  activeDiscoveryChildren.clear();
}

export function setToolchainDiscoveryProbeForTests(
  probe: ToolchainVersionProbe | undefined,
): void {
  testProbe = probe;
}

export function setToolchainDiscoveryStandardCandidatesForTests(
  provider: StandardCandidateProvider | undefined,
): void {
  testStandardCandidates = provider;
}

export function resetToolchainDiscoveryRuntimeForTests(): void {
  cancelToolchainDiscovery();
  runtimeStates.clear();
}
