export const SCORE_EXPORT_CONTENT_TYPE = "application/vnd.judgedesk.score-export-v1";
export const MAX_SCORE_EXPORT_PART_BYTES = 25 * 1024 * 1024;
export const MAX_SCORE_EXPORT_PAYLOAD_BYTES = MAX_SCORE_EXPORT_PART_BYTES * 2 + 12;

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
  validatePartSizes(workbook.byteLength, diagnostics.byteLength);
  const payload = new Uint8Array(HEADER_BYTES + diagnostics.byteLength + workbook.byteLength);
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
  validatePartSizes(workbook.byteLength, diagnosticsLength);
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

function validatePartSizes(workbookBytes: number, diagnosticsBytes: number): void {
  if (workbookBytes <= 0 || workbookBytes > MAX_SCORE_EXPORT_PART_BYTES) {
    throw new Error("Workbook is empty or too large.");
  }
  if (diagnosticsBytes <= 0 || diagnosticsBytes > MAX_SCORE_EXPORT_PART_BYTES) {
    throw new Error("Diagnostic JSON is required and must be at most 25 MiB.");
  }
}
