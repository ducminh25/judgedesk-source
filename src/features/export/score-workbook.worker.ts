import {
  buildDiagnosticJson,
  buildScoreWorkbookBytes,
  type ScoreExportBuildRequest,
} from "./score-workbook";

interface ScoreExportWorkerSuccess {
  success: true;
  workbook: ArrayBuffer;
  diagnosticJson: string;
}

interface ScoreExportWorkerFailure {
  success: false;
  message: string;
}

globalThis.onmessage = async (event: MessageEvent<ScoreExportBuildRequest>) => {
  try {
    const request = event.data;
    const workbook = await buildScoreWorkbookBytes(
      request.judgeResult,
      request.contestantNames,
      request.problemNames,
      request.labels,
      request.fallbackMetadata,
    );
    const diagnosticJson = buildDiagnosticJson(
      request.judgeResult,
      request.contestantNames,
      request.problemNames,
      request.fallbackMetadata,
    );
    const response: ScoreExportWorkerSuccess = {
      success: true,
      workbook: workbook.buffer as ArrayBuffer,
      diagnosticJson,
    };
    globalThis.postMessage(response, { transfer: [response.workbook] });
  } catch (error) {
    const response: ScoreExportWorkerFailure = {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
    globalThis.postMessage(response);
  }
};
