export const SCORE_EXPORT_CONTENT_TYPE = "application/vnd.judgedesk.score-export-v1";

export interface ScoreExportResult {
  success: true;
  saved: true;
  path: string;
  diagnosticsPath: string;
  openStatus: "launched" | "failed";
  openMode: "excel-unsaved" | "system-open" | null;
  openError: string | null;
}

export function parseScoreExportResult(value: unknown): ScoreExportResult {
  if (!value || typeof value !== "object"
    || !("success" in value) || value.success !== true
    || !("saved" in value) || value.saved !== true
    || !("path" in value) || typeof value.path !== "string" || !value.path
    || !("diagnosticsPath" in value) || typeof value.diagnosticsPath !== "string" || !value.diagnosticsPath
    || !("openStatus" in value) || (value.openStatus !== "launched" && value.openStatus !== "failed")
    || !("openMode" in value) || (value.openMode !== null && value.openMode !== "excel-unsaved" && value.openMode !== "system-open")
    || !("openError" in value) || (value.openError !== null && typeof value.openError !== "string")
    || (value.openStatus === "failed" && !value.openError)
    || (value.openStatus === "launched" && (!value.openMode || value.openError !== null))) {
    throw new Error("Invalid score export result");
  }
  return { success: true, saved: true, path: value.path, diagnosticsPath: value.diagnosticsPath,
    openStatus: value.openStatus,
    openMode: value.openMode === "excel-unsaved" ? "excel-unsaved" : value.openMode === "system-open" ? "system-open" : null,
    openError: typeof value.openError === "string" ? value.openError : null };
}
export const MAX_SCORE_EXPORT_PAYLOAD_BYTES = 256 * 1024 * 1024;

const MAGIC = new Uint8Array([0x4a, 0x44, 0x58, 0x4c, 0x53, 0x58, 0x30, 0x31]);
const HEADER_BYTES = MAGIC.length + 4;

export interface DecodedScoreExportPayload {
  workbook: Uint8Array;
  diagnosticJson: string;
}

export function encodeScoreExportPayload(
  workbook: Uint8Array,
  diagnosticJson: string,
): Uint8Array {
  const diagnostics = new TextEncoder().encode(diagnosticJson);
  const payloadBytes = HEADER_BYTES + diagnostics.byteLength + workbook.byteLength;
  validatePayloadSizes(workbook.byteLength, diagnostics.byteLength, payloadBytes);
  const payload = new Uint8Array(payloadBytes);
  payload.set(MAGIC, 0);
  new DataView(payload.buffer).setUint32(MAGIC.length, diagnostics.byteLength, true);
  payload.set(diagnostics, HEADER_BYTES);
  payload.set(workbook, HEADER_BYTES + diagnostics.byteLength);
  return payload;
}

export function decodeScoreExportPayload(payload: Uint8Array): DecodedScoreExportPayload {
  if (payload.byteLength < HEADER_BYTES || payload.byteLength > MAX_SCORE_EXPORT_PAYLOAD_BYTES) {
    throw new Error("Score export payload is empty or too large.");
  }
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (payload[index] !== MAGIC[index]) throw new Error("Score export payload header is invalid.");
  }
  const diagnosticsLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    HEADER_BYTES,
  ).getUint32(MAGIC.length, true);
  const workbookOffset = HEADER_BYTES + diagnosticsLength;
  if (workbookOffset > payload.byteLength) {
    throw new Error("Score export payload is truncated.");
  }
  const workbook = payload.subarray(workbookOffset);
  validatePayloadSizes(workbook.byteLength, diagnosticsLength, payload.byteLength);
  const diagnosticJson = new TextDecoder("utf-8", { fatal: true }).decode(
    payload.subarray(HEADER_BYTES, workbookOffset),
  );
  try {
    JSON.parse(diagnosticJson);
  } catch {
    throw new Error("Diagnostic JSON is invalid.");
  }
  return { workbook, diagnosticJson };
}

function validatePayloadSizes(
  workbookBytes: number,
  diagnosticsBytes: number,
  payloadBytes: number,
): void {
  if (workbookBytes <= 0) throw new Error("Workbook is empty.");
  if (diagnosticsBytes <= 0) throw new Error("Diagnostic JSON is required.");
  if (payloadBytes > MAX_SCORE_EXPORT_PAYLOAD_BYTES) {
    throw new Error("Score export exceeds the 256 MiB safety limit.");
  }
}
