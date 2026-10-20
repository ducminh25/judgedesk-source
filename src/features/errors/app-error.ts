import type { TFunction } from "i18next";

export type ErrorSeverity = "error" | "warning" | "info";

export interface AppError {
  id?: string;
  code?: string;
  title: string;
  reason?: string;
  action?: string;
  actionLabel?: string;
  onAction?: () => void;
  severity?: ErrorSeverity;
  timestamp?: number;
  rawDetails?: string;
}

export interface AppErrorOptions {
  title?: string;
  reason?: string;
  action?: string;
  actionLabel?: string;
  onAction?: () => void;
  severity?: ErrorSeverity;
  code?: string;
}

/**
 * Sanitizes technical error messages to avoid leaking sensitive internal details
 * such as local file paths (C:\Users\username\...), stack traces, and internal runtime internals.
 */
export function sanitizeErrorMessage(rawMessage: string): string {
  if (!rawMessage) return "";

  let sanitized = rawMessage;

  // 1. Remove Windows user paths (e.g., C:\Users\john\...)
  sanitized = sanitized.replace(/[A-Za-z]:\\[Uu]sers\\[^\\]+\\/g, "~\\");
  // 2. Remove Unix/macOS user paths (e.g., /Users/john/... or /home/john/...)
  sanitized = sanitized.replace(/\/(?:Users|home)\/[^/]+\//g, "~/");
  // 3. Remove stack trace lines (e.g., "at Function.xyz (/path:123:45)")
  sanitized = sanitized.replace(/\s+at\s+.+\(.*?\)/g, "");
  sanitized = sanitized.replace(/\s+at\s+[^\n]+/g, "");
  // 4. Strip Node.js / V8 exception prefixes if present
  sanitized = sanitized.replace(/^(?:Error|TypeError|RangeError|SyntaxError):\s*/i, "");

  return sanitized.trim();
}

/**
 * Maps any error (Error instance, API response object, or string) into a structured
 * user-friendly AppError with What, Why, and Action.
 */
export function formatAppError(
  error: unknown,
  options: AppErrorOptions = {},
  t?: TFunction,
): AppError {
  const translate = (key: string, fallback: string, interpolations?: Record<string, any>): string => {
    if (t) {
      const translated = t(key, interpolations);
      if (typeof translated === "string" && translated !== key) return translated;
    }
    return fallback;
  };

  const rawStr = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : (error && typeof error === "object" && "message" in error)
        ? String((error as any).message)
        : "";

  const errorCode = options.code
    || (error && typeof error === "object" && "code" in error ? String((error as any).code) : "");

  const sanitized = sanitizeErrorMessage(rawStr);

  // Default baseline
  let resolvedCode = errorCode || undefined;
  let title = options.title || translate("appErrors.generic.title", "Đã xảy ra sự cố");
  let reason = options.reason || translate("appErrors.generic.reason", "Thao tác không thể hoàn tất.");
  let action = options.action || translate("appErrors.generic.action", "Vui lòng kiểm tra lại dữ liệu và thử lại.");
  let severity: ErrorSeverity = options.severity || "error";

  // Match known patterns
  const lowerStr = rawStr.toLowerCase();

  if (
    errorCode === "BACKEND_CONNECTION"
    || lowerStr.includes("failed to fetch")
    || lowerStr.includes("econnrefused")
    || lowerStr.includes("networkerror")
    || lowerStr.includes("backendconnection")
  ) {
    resolvedCode = "BACKEND_CONNECTION";
    title = options.title || translate("appErrors.backendConnection.title", "Không thể kết nối dịch vụ chấm bài");
    reason = options.reason || translate("appErrors.backendConnection.reason", "Dịch vụ xử lý nền (Backend Service) chưa sẵn sàng hoặc bị chặn bởi phần mềm bảo mật.");
    action = options.action || translate("appErrors.backendConnection.action", "Hãy kiểm tra quyền ứng dụng và khởi động lại JudgeDesk.");
  } else if (
    errorCode === "MISSING_CONTESTANTS_PATH"
    || lowerStr.includes("contestants folder")
    || lowerStr.includes("thư mục thí sinh")
  ) {
    title = options.title || translate("appErrors.missingContestantsPath.title", "Chưa nạp thư mục Thí sinh");
    reason = options.reason || translate("appErrors.missingContestantsPath.reason", "Đường dẫn thư mục chứa bài làm của thí sinh đang để trống.");
    action = options.action || translate("appErrors.missingContestantsPath.action", "Nhấn «Nạp danh sách thí sinh» (phím F3) để chọn thư mục.");
  } else if (
    errorCode === "MISSING_TESTS_PATH"
    || lowerStr.includes("testcases folder")
    || lowerStr.includes("problems folder")
    || lowerStr.includes("thư mục bài thi")
  ) {
    title = options.title || translate("appErrors.missingTestsPath.title", "Chưa nạp thư mục Đề bài");
    reason = options.reason || translate("appErrors.missingTestsPath.reason", "Đường dẫn thư mục chứa các bài tập đang để trống.");
    action = options.action || translate("appErrors.missingTestsPath.action", "Nhấn «Nạp danh sách bài thi» (phím F2) để chọn thư mục đề.");
  } else if (
    errorCode === "NO_TARGETS_SELECTED"
    || lowerStr.includes("select at least one contestant")
    || lowerStr.includes("chưa chọn thí sinh")
  ) {
    title = options.title || translate("appErrors.noTargetsSelected.title", "Chưa chọn mục nào để chấm");
    reason = options.reason || translate("appErrors.noTargetsSelected.reason", "Chưa có thí sinh hoặc bài thi nào được tích chọn trên bảng điểm.");
    action = options.action || translate("appErrors.noTargetsSelected.action", "Hãy tích chọn ít nhất 1 thí sinh và 1 bài thi trên bảng điểm.");
    severity = "warning";
  } else if (
    errorCode === "DIRECTORY_NOT_FOUND"
    || lowerStr.includes("directory does not exist")
    || lowerStr.includes("enoent")
  ) {
    title = options.title || translate("appErrors.directoryNotFound.title", "Không tìm thấy thư mục");
    reason = options.reason || translate("appErrors.directoryNotFound.reason", "Đường dẫn thư mục không tồn tại hoặc đã bị đổi tên, di chuyển.");
    action = options.action || translate("appErrors.directoryNotFound.action", "Vui lòng kiểm tra lại đường dẫn hoặc chọn thư mục khác.");
  } else if (
    errorCode === "DIRECTORY_EMPTY"
    || lowerStr.includes("directory is empty")
    || lowerStr.includes("không có thư mục con")
  ) {
    title = options.title || translate("appErrors.directoryEmpty.title", "Thư mục không có dữ liệu hợp lệ");
    reason = options.reason || translate("appErrors.directoryEmpty.reason", "Thư mục đã chọn không chứa các thư mục con theo quy chuẩn bài thi hoặc thí sinh.");
    action = options.action || translate("appErrors.directoryEmpty.action", "Đảm bảo mỗi thí sinh hoặc mỗi bài tập là một thư mục con riêng biệt.");
    severity = "warning";
  } else if (
    errorCode === "PERMISSION_DENIED"
    || lowerStr.includes("eacces")
    || lowerStr.includes("eperm")
    || lowerStr.includes("permission denied")
  ) {
    title = options.title || translate("appErrors.permissionDenied.title", "Không có quyền truy cập");
    reason = options.reason || translate("appErrors.permissionDenied.reason", "Hệ điều hành từ chối quyền đọc/ghi vào thư mục hoặc tệp tin này.");
    action = options.action || translate("appErrors.permissionDenied.action", "Hãy kiểm tra quyền phân quyền (Read/Write) của thư mục hoặc chạy ứng dụng với quyền phù hợp.");
  } else if (
    errorCode === "FILE_LOCKED"
    || lowerStr.includes("ebusy")
    || lowerStr.includes("used by another process")
    || lowerStr.includes("file đang được mở")
  ) {
    title = options.title || translate("appErrors.fileLocked.title", "Tệp tin đang bị khóa");
    reason = options.reason || translate("appErrors.fileLocked.reason", "Tệp tin đang được mở bởi một chương trình khác (như Excel, Word, Text Editor).");
    action = options.action || translate("appErrors.fileLocked.action", "Hãy đóng tệp tin trong các ứng dụng đang mở rồi thử lại.");
  } else if (
    errorCode === "EXCEL_EXPORT_FAILED"
    || lowerStr.includes("open-excel")
    || lowerStr.includes("excel")
  ) {
    title = options.title || translate("appErrors.excelExportFailed.title", "Không thể xuất bảng điểm Excel");
    reason = options.reason || translate("appErrors.excelExportFailed.reason", "Không thể khởi chạy ứng dụng xem bảng tính hoặc tệp tạm thời bị khóa.");
    action = options.action || translate("appErrors.excelExportFailed.action", "Hãy cài đặt ứng dụng đọc file Excel (.xlsx) hoặc đóng các file Excel đang mở.");
  } else if (
    errorCode === "JUDGE_BUSY"
    || lowerStr.includes("judge is busy")
    || lowerStr.includes("dịch vụ chấm đang bận")
  ) {
    title = options.title || translate("appErrors.judgeBusy.title", "Dịch vụ chấm đang bận");
    reason = options.reason || translate("appErrors.judgeBusy.reason", "Một phiên chấm khác đang chiếm dụng tài nguyên hệ thống.");
    action = options.action || translate("appErrors.judgeBusy.action", "Vui lòng chờ phiên hiện tại kết thúc hoặc bấm nút Dừng.");
    severity = "warning";
  } else if (
    errorCode === "TOOLCHAIN_MISSING"
    || lowerStr.includes("toolchain")
    || lowerStr.includes("compiler")
  ) {
    title = options.title || translate("appErrors.toolchainMissing.title", "Trình biên dịch chưa sẵn sàng");
    reason = options.reason || translate("appErrors.toolchainMissing.reason", "Máy tính chưa có compiler phù hợp hoặc compiler chưa được xác thực.");
    action = options.action || translate("appErrors.toolchainMissing.action", "Mở «Quản lý trình biên dịch» (F6) để tải hoặc cấu hình compiler.");
  } else if (
    errorCode === "OSD_START_FAILED"
    || lowerStr.includes("osd")
  ) {
    title = options.title || translate("appErrors.osdFailed.title", "Không thể bật Chấm trực tuyến (OSD)");
    reason = options.reason || translate("appErrors.osdFailed.reason", "Thư mục nộp bài OSD không hợp lệ hoặc chưa nạp danh sách đề bài/thí sinh.");
    action = options.action || translate("appErrors.osdFailed.action", "Kiểm tra cấu hình OSD (F8) và nạp đầy đủ đề bài, thí sinh trước khi bật.");
  } else if (!options.reason && sanitized) {
    // Generic with sanitized reason
    reason = sanitized;
  }

  return {
    id: globalThis.crypto ? globalThis.crypto.randomUUID() : String(Date.now()),
    code: resolvedCode,
    title,
    reason,
    action,
    actionLabel: options.actionLabel,
    onAction: options.onAction,
    severity,
    timestamp: Date.now(),
    rawDetails: sanitized !== reason ? sanitized : undefined,
  };
}
