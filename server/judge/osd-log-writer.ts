import path from "node:path";
import { formatRationalDecimal, parseRational } from "../../shared/rational.js";
import type { ProblemResult } from "../types.js";
import { isSafeOsdComponent, parseOsdFileName } from "./osd-parser.js";
import { writeOsdFile } from "./osd-files.js";

export interface OsdLogOptions {
  osdPath: string;
  originalFileName: string;
  contestant?: string;
  problem?: string;
  language?: string;
  result?: ProblemResult;
  errorReason?: string;
  errorKind?: "rejected" | "judge";
  timestamp?: Date;
}

function oneLine(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, " ").trim();
}

/** Themis legacy wire format. Decimal rounding is presentation only. */
export function formatOsdLog(options: OsdLogOptions): string {
  const parsed = parseOsdFileName(options.originalFileName);
  const contestant = options.contestant || parsed.contestant || "Không xác định";
  const problem = options.problem || parsed.problem || "Không xác định";
  if (!isSafeOsdComponent(contestant) || !isSafeOsdComponent(problem)) {
    throw new Error("Invalid OSD log identifier");
  }
  const sourceName = parsed.extension ? `${problem}.${parsed.extension}` : path.basename(options.originalFileName);
  const prefix = `${contestant}‣${problem}`;
  const result = options.result;
  const errorLog = (verdict: string, details: string): string =>
    [`${prefix}: ${verdict}`, oneLine(sourceName), ...details.replace(/\r\n?/g, "\n").split("\n"), ""].join("\r\n");
  if (options.errorReason) {
    return options.errorKind === "judge"
      ? errorLog("ℱ Lỗi hệ thống chấm", options.errorReason)
      : errorLog("ℱ Từ chối bài nộp", `TRẠNG THÁI: TỪ CHỐI BÀI NỘP\n${options.errorReason}`);
  }
  if (!result) return errorLog("ℱ Lỗi hệ thống chấm", "Không có dữ liệu kết quả chấm.");
  const judgeErrors = result.testCases.filter(test => test.status === "JE" || test.status === "FAIL");
  if (result.summary.status === "JE" || result.summary.status === "FAIL" || judgeErrors.length > 0) {
    return errorLog("ℱ Lỗi hệ thống chấm", judgeErrors.map(test => test.errorDetail || test.checkerMessage || test.status).join("\n") || "Judge infrastructure error");
  }
  if (result.compileStatus === "CE") return errorLog("ℱ Dịch lỗi", result.compileError || "Compilation error");
  const score = formatRationalDecimal(parseRational(result.summary.scoreExact ?? result.summary.score), 6);
  const lines = [`${prefix}: ${score}`, oneLine(sourceName), "Dịch thành công", ""];
  for (const test of result.testCases) {
    if (!isSafeOsdComponent(test.name)) throw new Error("Invalid OSD testcase identifier");
    lines.push(`${prefix}‣${test.name}: ${formatRationalDecimal(parseRational(test.scoreExact ?? test.score), 6)}`);
    if (test.status === "TLE") {
      lines.push("Chạy quá thời gian");
    } else if (test.status === "RE") {
      lines.push("Chạy sinh lỗi", oneLine(test.errorDetail || test.checkerMessage || "Runtime error"));
    } else {
      if (!Number.isFinite(test.executionTime) || test.executionTime < 0) throw new Error("Invalid OSD execution time");
      lines.push(`Thời gian ≈ ${(test.executionTime / 1000).toFixed(6)} giây`);
      const labels: Record<string, string> = { AC: "Kết quả khớp đáp án!", WA: "Sai kết quả", PE: "Sai định dạng", MLE: "Vượt quá bộ nhớ", OLE: "Vượt quá giới hạn đầu ra" };
      const detail = oneLine(test.checkerMessage || test.errorDetail || "");
      lines.push(`${labels[test.status] || test.status}${detail ? `: ${detail}` : ""}`);
    }
  }
  return [...lines, ""].join("\r\n");
}

export function writeOsdLog(options: OsdLogOptions): string {
  return writeOsdFile(options.osdPath, ["logs"], `${options.originalFileName}.log`, formatOsdLog(options));
}
