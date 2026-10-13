import type { BatchJudgeResult, HostStatus, RunMetadata } from "../../types";
import type { TFunction } from "i18next";
import type {
  ScoreExportBuildRequest,
  ScoreWorkbookLabels,
} from "./score-workbook";

export interface ScoreExportArtifact {
  workbook: Uint8Array;
  diagnosticJson: string;
}

type ScoreExportWorkerResponse =
  | { success: true; workbook: ArrayBuffer; diagnosticJson: string }
  | { success: false; message: string };

import { APP_VERSION } from "../../version";

export function hostStatusToRunMetadata(
  hostStatus: HostStatus | null,
): RunMetadata {
  const isMac = typeof navigator !== "undefined"
    ? navigator.userAgent.includes("Mac")
    : (typeof process !== "undefined" ? process.platform === "darwin" : false);
  const platform = hostStatus?.platform || (isMac ? "darwin" : "win32");
  const arch = isMac ? "aarch64" : "x64";

  return {
    startedAt: new Date().toISOString(),
    platform,
    arch,
    build: hostStatus?.build || {
      appVersion: APP_VERSION,
      gitCommit: "release",
      buildNumber: "1",
      builtAt: new Date().toISOString(),
    },
    executor: {
      mode: hostStatus?.secureRunner.mode || (isMac ? "macos-sandbox" : "windows-lpac-job"),
      version: hostStatus?.secureRunner.executorVersion || APP_VERSION,
      ready: hostStatus?.secureRunner.ready ?? true,
    },
    toolchains: {
      cpp: {
        source: hostStatus?.gpp.source || "managed",
        version: hostStatus?.gpp.version || "14.2.0",
        submissionReady: hostStatus?.gpp.submissionReady ?? true,
        checkerReady: hostStatus?.gpp.checkerReady ?? true,
      },
      python: {
        source: hostStatus?.python.source || "managed",
        version: hostStatus?.python.version || "3.12",
        submissionReady: hostStatus?.python.submissionReady ?? true,
        checkerReady: hostStatus?.python.checkerReady ?? true,
      },
    },
  };
}

export async function buildScoreExport(
  judgeResult: BatchJudgeResult,
  contestantNames: string[],
  problemNames: string[],
  t: TFunction,
  fallbackMetadata?: RunMetadata,
): Promise<ScoreExportArtifact> {
  const request: ScoreExportBuildRequest = {
    judgeResult,
    contestantNames,
    problemNames,
    labels: createScoreWorkbookLabels(t),
    fallbackMetadata,
  };
  if (typeof Worker === "undefined") {
    throw new Error(t("export.workerUnavailable"));
  }

  const worker = new Worker(new URL("./score-workbook.worker.ts", import.meta.url), {
    type: "module",
    name: "judgedesk-score-export",
  });
  try {
    return await new Promise<ScoreExportArtifact>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ScoreExportWorkerResponse>) => {
        const response = event.data;
        if ("message" in response) {
          reject(new Error(response.message));
          return;
        }
        resolve({
          workbook: new Uint8Array(response.workbook),
          diagnosticJson: response.diagnosticJson,
        });
      };
      worker.onerror = (event) => reject(new Error(event.message || "Score export worker failed."));
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}

export function createScoreWorkbookLabels(t: TFunction): ScoreWorkbookLabels {
  return {
    scoreboardTitle: t("export.scoreboardTitle"),
    detailsTitle: t("export.detailsTitle"),
    candidate: t("scoringLog.candidate"),
    problem: t("scoringLog.problem"),
    test: t("scoringLog.test"),
    score: t("scoringLog.score"),
    time: t("scoringLog.time"),
    results: t("scoringLog.results"),
    total: t("scoreboard.total"),
    seconds: t("scoringLog.seconds"),
    notFound: t("export.notFound"),
    compilationError: t("export.compilationError"),
    judgeError: t("export.judgeError"),
    compilationSuccess: t("export.compilationSuccess"),
  };
}
