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

export function hostStatusToRunMetadata(
  hostStatus: HostStatus | null,
): RunMetadata | undefined {
  if (!hostStatus) return undefined;
  return {
    startedAt: new Date().toISOString(),
    platform: hostStatus.platform,
    arch: typeof process !== "undefined" && process.arch ? process.arch : "x64",
    build: hostStatus.build,
    executor: {
      mode: hostStatus.secureRunner.mode,
      version: hostStatus.secureRunner.executorVersion,
      ready: hostStatus.secureRunner.ready,
    },
    toolchains: {
      cpp: {
        source: hostStatus.gpp.source,
        version: hostStatus.gpp.version,
        submissionReady: hostStatus.gpp.submissionReady,
        checkerReady: hostStatus.gpp.checkerReady,
      },
      python: {
        source: hostStatus.python.source,
        version: hostStatus.python.version,
        submissionReady: hostStatus.python.submissionReady,
        checkerReady: hostStatus.python.checkerReady,
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
    compilationSuccess: t("export.compilationSuccess"),
  };
}
