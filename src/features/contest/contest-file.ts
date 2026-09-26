import type { BatchJudgeResult, ProblemConfig } from "../../types";
import { APP_VERSION } from "../../version";
import { isCanonicalRational } from "../../../shared/rational";

export const CONTEST_FORMAT = "judgedesk-contest" as const;
export const CONTEST_FORMAT_VERSION = 1 as const;

export interface ContestWorkspaceData {
  contestants: string[];
  problems: string[];
  problemConfigs: Record<string, ProblemConfig>;
  selectedContestants: Record<string, boolean>;
  selectedProblems: Record<string, boolean>;
  judgeResult: BatchJudgeResult | null;
}

export interface ContestManifest {
  format: typeof CONTEST_FORMAT;
  formatVersion: typeof CONTEST_FORMAT_VERSION;
  appVersion: string;
  createdAt: string;
  savedAt: string;
  workspace: ContestWorkspaceData;
}

export interface OpenedContestArchive {
  path: string;
  contestantsPath: string;
  testsPath: string;
  manifest: ContestManifest;
}

interface NativeOpenedArchive {
  contestantsPath: string;
  testsPath: string;
  manifest: unknown;
}

export function buildContestManifest(
  workspace: ContestWorkspaceData,
  createdAt?: string,
  now = new Date(),
): ContestManifest {
  const timestamp = now.toISOString();
  return {
    format: CONTEST_FORMAT,
    formatVersion: CONTEST_FORMAT_VERSION,
    appVersion: APP_VERSION,
    createdAt: createdAt || timestamp,
    savedAt: timestamp,
    workspace,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "boolean");
}

function isProblemConfigRecord(value: unknown): value is Record<string, ProblemConfig> {
  return isRecord(value) && Object.values(value).every((config) => {
    if (!isRecord(config) || typeof config.useStdIO !== "boolean") return false;
    if (config.totalScore !== null && typeof config.totalScore !== "number" && typeof config.totalScore !== "string") return false;
    if ((typeof config.defaultScore !== "number" && typeof config.defaultScore !== "string") || (typeof config.defaultScore === "number" && !Number.isFinite(config.defaultScore))) return false;
    return isRecord(config.testScores)
      && Object.values(config.testScores).every((score) => (typeof score === "number" && Number.isFinite(score)) || typeof score === "string");
  });
}

function isJudgeResult(value: unknown): value is BatchJudgeResult {
  if (!isRecord(value) || typeof value.success !== "boolean" || !Array.isArray(value.contestants)) {
    return false;
  }
  return value.contestants.every((contestant) => {
    if (!isRecord(contestant) || typeof contestant.contestantName !== "string" || !Array.isArray(contestant.problems)) {
      return false;
    }
    return contestant.problems.every((problem) => {
      if (!isRecord(problem) || typeof problem.problemName !== "string" || typeof problem.compileStatus !== "string") {
        return false;
      }
      if (!Array.isArray(problem.testCases) || !isRecord(problem.summary)) return false;
      if ((problem.summary.scoreExact !== undefined && !isCanonicalRational(problem.summary.scoreExact))
        || (problem.summary.maxScoreExact !== undefined && !isCanonicalRational(problem.summary.maxScoreExact))
        || !problem.testCases.every(test => isRecord(test) && (test.scoreExact === undefined || isCanonicalRational(test.scoreExact)))) return false;
      return typeof problem.summary.score === "number"
        && Number.isFinite(problem.summary.score)
        && typeof problem.summary.status === "string";
    });
  });
}

export function validateContestManifest(value: unknown): ContestManifest {
  if (!isRecord(value) || value.format !== CONTEST_FORMAT) {
    throw new Error("This is not a JudgeDesk contest file.");
  }
  if (value.formatVersion !== CONTEST_FORMAT_VERSION) {
    throw new Error("This JudgeDesk contest version is not supported.");
  }
  if (!isRecord(value.workspace)) {
    throw new Error("The contest workspace is missing.");
  }
  const workspace = value.workspace;
  if (!isStringArray(workspace.contestants) || !isStringArray(workspace.problems)) {
    throw new Error("The contest lists are invalid.");
  }
  if (!isProblemConfigRecord(workspace.problemConfigs)) {
    throw new Error("The problem configuration is invalid.");
  }
  if (!isBooleanRecord(workspace.selectedContestants) || !isBooleanRecord(workspace.selectedProblems)) {
    throw new Error("The contest selection state is invalid.");
  }
  if (workspace.judgeResult !== null && !isJudgeResult(workspace.judgeResult)) {
    throw new Error("The judging result is invalid.");
  }
  if (typeof value.createdAt !== "string" || typeof value.savedAt !== "string") {
    throw new Error("The contest timestamps are invalid.");
  }

  return value as unknown as ContestManifest;
}

export function ensureContestExtension(path: string): string {
  return path.toLowerCase().endsWith(".judgedesk") ? path : `${path}.judgedesk`;
}

export async function openContestArchiveFromPath(path: string): Promise<OpenedContestArchive> {
  const { invoke } = await import("@tauri-apps/api/core");
  const native = await invoke<NativeOpenedArchive>("open_contest_archive", { path });
  return {
    path,
    contestantsPath: native.contestantsPath,
    testsPath: native.testsPath,
    manifest: validateContestManifest(native.manifest),
  };
}

export async function chooseAndOpenContestArchive(): Promise<OpenedContestArchive | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "JudgeDesk Contest", extensions: ["judgedesk"] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  return openContestArchiveFromPath(selected);
}

export async function saveContestArchive(options: {
  currentPath: string | null;
  contestantsPath: string;
  testsPath: string;
  manifest: ContestManifest;
}): Promise<string | null> {
  const [{ save }, { invoke }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/api/core"),
  ]);
  const selected = options.currentPath || await save({
    defaultPath: "contest.judgedesk",
    filters: [{ name: "JudgeDesk Contest", extensions: ["judgedesk"] }],
  });
  if (!selected) return null;
  const destination = ensureContestExtension(selected);
  await invoke("save_contest_archive", {
    destination,
    contestantsPath: options.contestantsPath,
    testsPath: options.testsPath,
    manifestJson: JSON.stringify(options.manifest),
  });
  return destination;
}
