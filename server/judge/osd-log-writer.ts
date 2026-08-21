import fs from "node:fs";
import path from "node:path";
import type { ProblemResult } from "../types.js";

export interface OsdLogOptions {
  osdPath: string;
  originalFileName: string;
  contestant?: string;
  problem?: string;
  language?: string;
  result?: ProblemResult;
  errorReason?: string;
  timestamp?: Date;
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function formatOsdLog(options: OsdLogOptions): string {
  const now = options.timestamp ?? new Date();
  const formattedTime = formatDate(now);
  const lines: string[] = [];

  lines.push("================================================================================");
  lines.push("              BIÊN BẢN CHẤM BÀI - JUDGEDESK (THEMIS COMPATIBLE)                ");
  lines.push("================================================================================");
  lines.push(`Thí sinh      : ${options.contestant || "Không xác định"}`);
  lines.push(`Bài thi       : ${options.problem || "Không xác định"}`);
  lines.push(`Tệp nộp       : ${options.originalFileName}`);
  lines.push(`Ngôn ngữ      : ${options.language ? options.language.toUpperCase() : "Không xác định"}`);
  lines.push(`Thời gian     : ${formattedTime}`);
  lines.push("================================================================================");

  if (options.errorReason) {
    lines.push("");
    lines.push("TRẠNG THÁI: TỪ CHỐI BÀI NỘP");
    lines.push(`Lý do     : ${options.errorReason}`);
    lines.push("");
    lines.push("================================================================================");
    return lines.join("\n");
  }

  const res = options.result;
  if (!res) {
    lines.push("");
    lines.push("Không có dữ liệu kết quả chấm.");
    lines.push("================================================================================");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("KẾT QUẢ BIÊN DỊCH:");
  if (res.compileStatus === "OK") {
    const compileTimeStr = res.compileTime != null ? ` (${(res.compileTime / 1000).toFixed(3)}s)` : "";
    lines.push(`- Trạng thái: THÀNH CÔNG${compileTimeStr}`);
  } else if (res.compileStatus === "SKIPPED") {
    lines.push("- Trạng thái: BỎ QUA");
  } else {
    lines.push("- Trạng thái: LỖI BIÊN DỊCH (Compilation Error)");
    if (res.compileError) {
      lines.push("--------------------------------------------------------------------------------");
      lines.push(res.compileError.trim());
      lines.push("--------------------------------------------------------------------------------");
    }
  }

  if (res.compileStatus === "OK" && res.testCases.length > 0) {
    lines.push("");
    lines.push("CHI TIẾT CÁC TESTCASE:");
    for (let i = 0; i < res.testCases.length; i++) {
      const tc = res.testCases[i];
      const testNum = (i + 1).toString().padStart(2, "0");
      const timeStr = `${(tc.executionTime / 1000).toFixed(3)}s`;
      const memStr = tc.peakMemory ? `${(tc.peakMemory / 1024).toFixed(1)}MB` : "N/A";
      const scoreStr = `${tc.score.toFixed(2)}đ`;
      
      let statusLabel: string = tc.status;
      if (tc.status === "AC") statusLabel = "ĐÚNG";
      else if (tc.status === "WA") statusLabel = "SAI";
      else if (tc.status === "TLE") statusLabel = "CHẠY QUÁ THỜI GIAN";
      else if (tc.status === "MLE") statusLabel = "VƯỢT QUÁ BỘ NHỚ";
      else if (tc.status === "RE") statusLabel = "LỖI THỰC THI";

      lines.push(
        `Test ${testNum} (${tc.name}): [${statusLabel}] - Thời gian: ${timeStr}, Bộ nhớ: ${memStr} -> ${scoreStr}`,
      );
      if (tc.checkerMessage && tc.status !== "AC") {
        lines.push(`   * Thông báo: ${tc.checkerMessage.trim()}`);
      }
      if (tc.errorDetail) {
        lines.push(`   * Chi tiết: ${tc.errorDetail.trim()}`);
      }
    }
  }

  lines.push("");
  lines.push("================================================================================");
  lines.push(
    `TỔNG KẾT: ${res.summary.score.toFixed(2)} / ${res.summary.maxScore.toFixed(2)} điểm (${res.summary.passed}/${res.summary.total} tests đúng) - Trạng thái: ${res.summary.status}`,
  );
  lines.push("================================================================================");

  return lines.join("\n");
}

export function writeOsdLog(options: OsdLogOptions): string {
  const logDir = path.join(options.osdPath, "Logs");
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logContent = formatOsdLog(options);
  const logFilePath = path.join(logDir, `${options.originalFileName}.log`);
  fs.writeFileSync(logFilePath, logContent, "utf8");
  return logFilePath;
}
