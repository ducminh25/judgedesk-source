import crypto from "node:crypto";
import {
  execFile as execFileCallback,
  spawnSync,
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
const DISCOVERY_DEADLINE_MS = 2_500;

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
  isAborted?: boolean;
  nextRescanPromise?: Promise<ToolchainDiscoverySnapshot>;
  resolveNextRescan?: (s: ToolchainDiscoverySnapshot) => void;
  rejectNextRescan?: (err: unknown) => void;
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

export function startInitialToolchainDiscovery(): Promise<ToolchainDiscoverySnapshot> {
  const runtime = runtimeState();
  if (runtime.initialRefreshStarted) {
    return Promise.resolve(runtime.snapshot);
  }
  runtime.initialRefreshStarted = true;
  return startDiscovery(runtime);
}

export function requestToolchainRescan(): Promise<ToolchainDiscoverySnapshot> {
  const runtime = runtimeState();
  if (runtime.promise) {
    runtime.rescanRequested = true;
    if (!runtime.nextRescanPromise) {
      let resolveFn!: (s: ToolchainDiscoverySnapshot) => void;
      let rejectFn!: (err: unknown) => void;
      runtime.nextRescanPromise = new Promise<ToolchainDiscoverySnapshot>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      runtime.resolveNextRescan = resolveFn;
      runtime.rejectNextRescan = rejectFn;
    }
    return runtime.nextRescanPromise;
  }
  return startDiscovery(runtime);
}

export async function waitForToolchainDiscovery(): Promise<ToolchainDiscoverySnapshot> {
  const runtime = runtimeState();
  return runtime.promise || runtime.snapshot;
}

function startDiscovery(runtime: RuntimeDiscoveryState): Promise<ToolchainDiscoverySnapshot> {
  if (runtime.promise) return runtime.promise;
  runtime.isAborted = false;
  const targetFilePath = getToolchainDiscoveryFilePath();
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
  const isAborted = () => !!runtime.isAborted;
  const discoveryPromise = Promise.resolve()
    .then(() => runDiscovery(retainedProfiles, isAborted))
    .then((snapshot) => {
      if (runtime.isAborted) {
        return snapshot;
      }
      writeDiscoverySnapshot(snapshot, targetFilePath, isAborted);
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
      if (runtime.isAborted) {
        runtime.rescanRequested = false;
        if (runtime.resolveNextRescan) {
          runtime.resolveNextRescan(runtime.snapshot);
          runtime.nextRescanPromise = undefined;
          runtime.resolveNextRescan = undefined;
          runtime.rejectNextRescan = undefined;
        }
        return;
      }
      if (runtime.rescanRequested) {
        runtime.rescanRequested = false;
        const nextPromise = startDiscovery(runtime);
        const resolve = runtime.resolveNextRescan;
        const reject = runtime.rejectNextRescan;
        runtime.nextRescanPromise = undefined;
        runtime.resolveNextRescan = undefined;
        runtime.rejectNextRescan = undefined;
        if (resolve) {
          nextPromise.then(resolve, reject);
        }
      }
    });

  runtime.promise = discoveryPromise;
  return discoveryPromise;
}

async function runDiscovery(
  previousProfiles: DiscoveryProfiles,
  isAborted?: () => boolean,
): Promise<Extract<ToolchainDiscoverySnapshot, { status: "complete" }>> {
  const profiles: Record<string, DiscoveredToolchainCandidate[]> = emptyProfiles();
  const deadlineAt = Date.now() + DISCOVERY_DEADLINE_MS;
  await Promise.all(listRegisteredLanguageProfiles().map(async (entry) => {
    const profileId = entry.profile.ref.id;
    if (isAborted?.()) {
      profiles[profileId] = [...(previousProfiles[profileId] || [])];
      return;
    }
    try {
      profiles[profileId] = await discoverKind(
        profileId,
        entry.toolchainKind,
        deadlineAt,
        isAborted,
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
  isAborted?: () => boolean,
): Promise<DiscoveredToolchainCandidate[]> {
  const attempts: DiscoveredToolchainCandidate[] = [];
  const seen = new Set<string>();
  if (isAborted?.()) return attempts;
  const selectedLocation = selectedLocalPathLocation(kind);
  if (selectedLocation) {
    await probeLocations(
      profileId,
      kind,
      [selectedLocation],
      attempts,
      seen,
      deadlineAt,
      isAborted,
    );
  }
  if (!isAborted?.() && Date.now() < deadlineAt && attempts.length < MAX_CANDIDATES_PER_PROFILE) {
    const pathLocations = collectPathCandidates(kind);
    await probeLocations(
      profileId,
      kind,
      pathLocations,
      attempts,
      seen,
      deadlineAt,
      isAborted,
    );
  }
  if (!isAborted?.() && Date.now() < deadlineAt && attempts.length < MAX_CANDIDATES_PER_PROFILE) {
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
      isAborted,
    );
  }
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
  isAborted?: () => boolean,
): Promise<boolean> {
  for (const location of locations) {
    if (
      isAborted?.()
      || attempts.length >= MAX_CANDIDATES_PER_PROFILE
      || Date.now() >= deadlineAt
    ) {
      break;
    }
    const canonicalPath = await canonicalExecutablePath(
      location.displayPath,
      kind,
      deadlineAt,
    );
    if (isAborted?.()) break;
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
    if (isAborted?.()) break;
    attempts.push(candidate);
  }
  return attempts.some(
    (candidate) =>
      candidate.error === null
      && candidate.family !== null
      && candidate.version !== null,
  );
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

const activeCompatibilityProbes = new Map<Promise<unknown>, AbortController>();
const settledCompatibilityErrors: unknown[] = [];

function scheduleCompatibilityProbe(
  kind: ToolchainKind,
  executablePath: string,
): void {
  if (testProbe || (kind !== "cpp" && kind !== "c" && kind !== "python")) {
    return;
  }
  const controller = new AbortController();
  const probePromise = import("./local-execution.js")
    .then(({ scheduleLocalCompatibilityProbe }) =>
      scheduleLocalCompatibilityProbe(kind, executablePath, undefined, controller.signal),
    )
    .catch((error) => {
      console.error(`[Toolchains] Local compatibility probe failed to start for ${kind}:`, error);
      throw error;
    });
  activeCompatibilityProbes.set(probePromise, controller);
  probePromise
    .catch((err: unknown) => {
      settledCompatibilityErrors.push(err);
    })
    .finally(() => {
      activeCompatibilityProbes.delete(probePromise);
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
    scratch: ["--version"],
  };
  return args[kind];
}

export function parseVersionOutput(
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
    const version = first(/Python\s+([0-9.]+)/i, /Python\s+([^\s]+)/i);
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
    const version = first(
      /(?:javac|openjdk|java)\s+(?:version\s+)?"?([0-9]+(?:\.[0-9]+)*)/i,
      /(?:javac|openjdk|java)\s+(?:version\s+)?"?([^\s"]+)/i,
    );
    return version
      ? { family: "java", version: version.replace(/-.*$/, ""), target: null }
      : null;
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
  if (kind === "scratch") {
    const version = first(
      /^v?(\d+(?:\.\d+){1,3}(?:[-+][^\s]+)?)\s*$/im,
      /version\s+(\d+(?:\.\d+){1,3})/i,
    );
    return version ? { family: "scratch-vm", version, target: null } : null;
  }
  const version = first(/^(\d+(?:\.\d+){1,3}(?:[-+][^\s]+)?)\s*$/im);
  return version ? { family: "dotnet-sdk", version, target: null } : null;
}

function shortProbeError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, MAX_ERROR_LENGTH);
  if (!isRecord(error)) return "probe_failed";
  const message = typeof error.message === "string" ? error.message : "";
  const code = typeof error.code === "string" ? error.code : "";
  const normalized = code ? `${code}: ${message}` : message;
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

function trackDiscoveryChildProcess(child: ChildProcess): void {
  activeDiscoveryChildren.add(child);
  const onTerminal = () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      activeDiscoveryChildren.delete(child);
    }
  };
  child.once("exit", onTerminal);
  child.once("close", onTerminal);
}

async function runVersionCommand(
  request: ToolchainVersionProbeRequest,
): Promise<ToolchainVersionProbeOutput> {
  const timeoutMs = request.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = execFileCallback(
        request.executablePath,
        [...request.args],
        {
          timeout: timeoutMs,
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            activeDiscoveryChildren.delete(child);
          }
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    trackDiscoveryChildProcess(child);
  });
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
        if (child.exitCode !== null || child.signalCode !== null) {
          activeDiscoveryChildren.delete(child);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    trackDiscoveryChildProcess(child);
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

function getThemisRoots(): string[] {
  const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const programFilesX86 = process.env["ProgramFiles(x86)"]
    || String.raw`C:\Program Files (x86)`;
  const systemDrive = process.env.SystemDrive || "C:";
  const roots = [
    path.join(programFiles, "Themis"),
    path.join(programFilesX86, "Themis"),
    path.join(systemDrive, "\\Themis"),
    String.raw`C:\Themis`,
    String.raw`D:\Themis`,
    String.raw`E:\Themis`,
  ];
  return [...new Set(roots)];
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
  const themisRoots = getThemisRoots();

  if (kind === "cpp" || kind === "c") {
    const executable = kind === "cpp" ? "g++.exe" : "gcc.exe";
    const candidates: string[] = [
      path.join(String.raw`C:\msys64\ucrt64\bin`, executable),
      path.join(String.raw`C:\msys64\mingw64\bin`, executable),
    ];
    for (const root of themisRoots) {
      candidates.push(
        path.join(root, "GCC", "bin", executable),
        path.join(root, "gcc", "bin", executable),
        path.join(root, "MinGW", "bin", executable),
        path.join(root, "mingw", "bin", executable),
        path.join(root, "bin", executable),
      );
    }
    candidates.push(
      path.join(programFiles, "CodeBlocks", "MinGW", "bin", executable),
      path.join(programFilesX86, "CodeBlocks", "MinGW", "bin", executable),
      path.join(localAppData, "Programs", "CodeBlocks", "MinGW", "bin", executable),
      path.join(String.raw`C:\MinGW\bin`, executable),
      path.join(userProfile, "scoop", "apps", "gcc", "current", "bin", executable),
    );
    return candidates;
  }
  if (kind === "python") {
    const candidates: string[] = [];
    for (const root of themisRoots) {
      candidates.push(
        path.join(root, "Python", "python.exe"),
        path.join(root, "PYTHON", "python.exe"),
        path.join(root, "python", "python.exe"),
        path.join(root, "Python3", "python.exe"),
        path.join(root, "Python313", "python.exe"),
        path.join(root, "Python312", "python.exe"),
        path.join(root, "Python311", "python.exe"),
        path.join(root, "Python310", "python.exe"),
        path.join(root, "Python38", "python.exe"),
        path.join(root, "Python37", "python.exe"),
        path.join(root, "python.exe"),
      );
    }
    candidates.push(
      String.raw`C:\Python313\python.exe`,
      String.raw`C:\Python312\python.exe`,
      String.raw`C:\Python311\python.exe`,
      String.raw`C:\Python310\python.exe`,
      String.raw`C:\Python39\python.exe`,
      String.raw`C:\Python38\python.exe`,
      String.raw`C:\Python37\python.exe`,
      path.join(userProfile, "scoop", "apps", "python", "current", "python.exe"),
    );
    const pythonRoot = path.join(localAppData, "Programs", "Python");
    for (const child of await listImmediateDirectories(pythonRoot, deadlineAt)) {
      candidates.push(path.join(child, "python.exe"));
    }
    return candidates;
  }
  const configuredHome = configuredToolchainHome(kind);
  if (kind === "java") {
    const candidates: string[] = [];
    for (const root of themisRoots) {
      candidates.push(
        path.join(root, "JDK", "bin", "javac.exe"),
        path.join(root, "jdk", "bin", "javac.exe"),
        path.join(root, "Java", "bin", "javac.exe"),
        path.join(root, "java", "bin", "javac.exe"),
      );
      for (const sub of ["JDK", "jdk", "Java", "java"]) {
        for (const child of await listImmediateDirectories(path.join(root, sub), deadlineAt)) {
          candidates.push(path.join(child, "bin", "javac.exe"));
        }
      }
    }
    if (configuredHome) candidates.push(path.join(configuredHome, "bin", "javac.exe"));
    for (const vendorRoot of [
      String.raw`C:\Program Files\Eclipse Adoptium`,
      String.raw`C:\Program Files (x86)\Eclipse Adoptium`,
      String.raw`C:\Program Files\Java`,
      String.raw`C:\Program Files (x86)\Java`,
      String.raw`C:\Program Files\Microsoft`,
      String.raw`C:\Program Files\Amazon Corretto`,
      String.raw`C:\Program Files\Zulu`,
    ]) {
      for (const child of await listImmediateDirectories(vendorRoot, deadlineAt)) {
        candidates.push(path.join(child, "bin", "javac.exe"));
      }
    }
    for (const rootChild of await listImmediateDirectories("C:\\", deadlineAt)) {
      if (path.basename(rootChild).toLowerCase().startsWith("jdk")) {
        candidates.push(path.join(rootChild, "bin", "javac.exe"));
      }
    }
    return candidates;
  }
  const standard: Record<
    Exclude<ToolchainKind, "cpp" | "c" | "python" | "java">,
    string[]
  > = {
    pascal: [],
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
    scratch: [],
  };
  if (kind === "pascal") {
    const pascalCandidates: string[] = [];
    for (const root of themisRoots) {
      pascalCandidates.push(
        path.join(root, "FPC", "bin", "i386-win32", "fpc.exe"),
        path.join(root, "fpc", "bin", "i386-win32", "fpc.exe"),
        path.join(root, "FPC", "bin", "x86_64-win64", "fpc.exe"),
        path.join(root, "fpc", "bin", "x86_64-win64", "fpc.exe"),
        path.join(root, "FPC", "bin", "fpc.exe"),
        path.join(root, "fpc", "bin", "fpc.exe"),
      );
      for (const sub of ["FPC", "fpc"]) {
        for (const child of await listImmediateDirectories(path.join(root, sub), deadlineAt)) {
          pascalCandidates.push(
            path.join(child, "bin", "i386-win32", "fpc.exe"),
            path.join(child, "bin", "x86_64-win64", "fpc.exe"),
            path.join(child, "bin", "fpc.exe"),
          );
        }
      }
    }
    pascalCandidates.push(
      String.raw`C:\FPC\3.2.2\bin\x86_64-win64\fpc.exe`,
      String.raw`C:\FPC\3.2.2\bin\i386-win32\fpc.exe`,
      String.raw`C:\FPC\3.2.0\bin\i386-win32\fpc.exe`,
      String.raw`C:\FPC\3.0.4\bin\i386-win32\fpc.exe`,
      String.raw`C:\lazarus\fpc\3.2.2\bin\x86_64-win64\fpc.exe`,
      String.raw`C:\lazarus\fpc\3.2.2\bin\i386-win32\fpc.exe`,
    );
    return pascalCandidates;
  }
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
    scratch: [],
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
    scratch: ["scratch-run"],
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
  targetFilePath?: string,
  isAborted?: () => boolean,
): void {
  if (isAborted?.()) return;
  const persisted = { ...snapshot, refreshing: false, startedAt: undefined };
  const filePath = targetFilePath || getToolchainDiscoveryFilePath();
  const targetDir = path.dirname(filePath);
  if (!fs.existsSync(targetDir)) {
    return;
  }
  const canonicalJson = `${JSON.stringify(persisted, null, 2)}\n`;
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_DISCOVERY_BYTES) {
    throw new Error("Toolchain discovery result exceeds its storage limit.");
  }
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    if (isAborted?.()) return;
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, canonicalJson, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (isAborted?.()) {
      fs.rmSync(temporaryPath, { force: true });
      return;
    }
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** Stops in-flight discovery processes during application shutdown. */
export function cancelToolchainDiscovery(): unknown[] {
  const errors: unknown[] = [];
  for (const runtime of runtimeStates.values()) {
    runtime.isAborted = true;
    runtime.rescanRequested = false;
  }
  for (const controller of activeCompatibilityProbes.values()) {
    try {
      controller.abort();
    } catch (err) {
      errors.push(err);
    }
  }
  for (const child of activeDiscoveryChildren) {
    try {
      if (process.platform === "win32" && child.pid) {
        const res = spawnSync("taskkill", ["/F", "/T", "/PID", child.pid.toString()], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (res.error) {
          errors.push(res.error);
        } else if (res.status !== null && res.status !== 0 && res.status !== 128) {
          const stderr = (res.stderr || "").trim();
          errors.push(new Error(`taskkill failed with exit code ${res.status}: ${stderr}`));
        }
      } else {
        const killed = child.kill("SIGKILL");
        if (!killed && child.exitCode === null && child.signalCode === null) {
          errors.push(new Error(`Failed to send SIGKILL to child process ${child.pid}`));
        }
      }
    } catch (err: unknown) {
      errors.push(err);
    }
  }
  return errors;
}

/** Cancels in-flight discovery and awaits all in-flight promises and child processes to drain. */
export async function drainToolchainDiscovery(deadlineMs = 3000): Promise<void> {
  const killErrors = cancelToolchainDiscovery();
  const errors: unknown[] = [...killErrors, ...settledCompatibilityErrors];

  const pending: Promise<unknown>[] = [];
  for (const runtime of runtimeStates.values()) {
    if (runtime.promise) {
      pending.push(runtime.promise);
    }
    if (runtime.nextRescanPromise) {
      pending.push(runtime.nextRescanPromise);
    }
  }

  const probeOps: Promise<unknown>[] = Array.from(activeCompatibilityProbes.keys());

  const childWaitOps: Promise<void>[] = [];
  if (activeDiscoveryChildren.size > 0) {
    for (const child of Array.from(activeDiscoveryChildren)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        activeDiscoveryChildren.delete(child);
        continue;
      }
      childWaitOps.push(
        new Promise<void>((resolve, reject) => {
          let timer: NodeJS.Timeout | null = null;
          let settled = false;
          const cleanup = () => {
            if (timer) clearTimeout(timer);
            child.removeListener("exit", onTerminal);
            child.removeListener("close", onTerminal);
            child.removeListener("error", onError);
          };
          const onTerminal = () => {
            if (!settled && (child.exitCode !== null || child.signalCode !== null)) {
              settled = true;
              cleanup();
              activeDiscoveryChildren.delete(child);
              resolve();
            }
          };
          const onError = (err: unknown) => {
            errors.push(err);
            // Do NOT resolve drain as exit! Process must still emit terminal exit/close.
          };
          child.once("exit", onTerminal);
          child.once("close", onTerminal);
          child.once("error", onError);
          if (child.exitCode !== null || child.signalCode !== null) {
            settled = true;
            cleanup();
            activeDiscoveryChildren.delete(child);
            resolve();
            return;
          }
          timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              if (child.exitCode === null && child.signalCode === null) {
                reject(
                  new Error(
                    `Discovery child process PID ${child.pid} failed to exit within ${deadlineMs}ms deadline`,
                  ),
                );
              } else {
                activeDiscoveryChildren.delete(child);
                resolve();
              }
            }
          }, deadlineMs);
        }),
      );
    }
  }

  const allOps = [...pending, ...probeOps, ...childWaitOps];
  if (allOps.length > 0) {
    let overallTimer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      overallTimer = setTimeout(() => {
        reject(new Error(`drainToolchainDiscovery timed out after ${deadlineMs}ms`));
      }, deadlineMs);
    });
    try {
      const results = await Promise.race([
        Promise.allSettled(allOps),
        timeoutPromise,
      ]);
      for (const res of results) {
        if (res.status === "rejected") {
          errors.push(res.reason);
        }
      }
    } catch (timeoutErr) {
      errors.push(timeoutErr);
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
    }
  }

  if (activeDiscoveryChildren.size === 0) {
    runtimeStates.clear();
  }

  if (errors.length > 0) {
    const errorObjects = errors.map((e) => (e instanceof Error ? e : new Error(String(e))));
    const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
    throw new AggregateError(
      errorObjects,
      `drainToolchainDiscovery failed with ${errors.length} background/kill error(s):\n  ${messages.join("\n  ")}`,
    );
  }
}

export function registerDiscoveryChildForTests(child: ChildProcess): void {
  trackDiscoveryChildProcess(child);
}

export function getActiveDiscoveryChildrenCountForTests(): number {
  return activeDiscoveryChildren.size;
}

export function registerCompatibilityProbeForTests(
  probe: Promise<unknown>,
  controller: AbortController = new AbortController(),
): void {
  activeCompatibilityProbes.set(probe, controller);
  probe
    .catch((err: unknown) => {
      settledCompatibilityErrors.push(err);
    })
    .finally(() => {
      activeCompatibilityProbes.delete(probe);
    });
}

export function getActiveCompatibilityProbesCountForTests(): number {
  return activeCompatibilityProbes.size;
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
  if (activeDiscoveryChildren.size === 0) {
    runtimeStates.clear();
  }
  activeCompatibilityProbes.clear();
  settledCompatibilityErrors.length = 0;
}

export function forceClearToolchainDiscoveryRuntimeForTests(): void {
  cancelToolchainDiscovery();
  activeDiscoveryChildren.clear();
  runtimeStates.clear();
  activeCompatibilityProbes.clear();
  settledCompatibilityErrors.length = 0;
}
