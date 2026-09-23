import { useEffect, useState } from "react";
import { FolderSync, FolderOpen, X, CheckCircle2, AlertCircle, Info, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { selectDirectory } from "../../platform/directory-picker";
import type { OsdStatusState } from "./useOsdSession";

interface Props {
  status: OsdStatusState;
  contestantsPath: string;
  testPath: string;
  onStart: (options: { osdPath: string; enableLog: boolean }) => Promise<{ success: boolean; message?: string }>;
  onStop: () => Promise<void>;
  onClose: () => void;
}

export default function OsdSettingsModal({
  status,
  contestantsPath,
  testPath,
  onStart,
  onStop,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [osdPath, setOsdPath] = useState<string>(() => {
    if (status.osdPath) return status.osdPath;
    if (contestantsPath) {
      const parent = contestantsPath.replace(/[/\\][^/\\]+[/\\]?$/, "");
      return parent ? `${parent}/Submit` : `${contestantsPath}_Submit`;
    }
    return "";
  });
  const [enableLog, setEnableLog] = useState<boolean>(status.enableLog !== false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string>("");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleBrowse = async () => {
    try {
      const selected = await selectDirectory(osdPath);
      if (selected) {
        setOsdPath(selected);
      }
    } catch (err: any) {
      console.error("Browse OSD folder failed:", err);
    }
  };

  const handleToggle = async () => {
    setLocalError("");
    setIsLoading(true);
    try {
      if (status.active) {
        await onStop();
      } else {
        if (!osdPath.trim()) {
          setLocalError(t("osd.pathRequired", { defaultValue: "Vui lòng chọn thư mục nộp bài OSD." }));
          setIsLoading(false);
          return;
        }
        if (!contestantsPath.trim() || !testPath.trim()) {
          setLocalError(
            t("osd.workspaceRequired", {
              defaultValue: "Cần nạp Thư mục Thí sinh và Thư mục Đề thi trước khi bật Chấm trực tuyến.",
            }),
          );
          setIsLoading(false);
          return;
        }
        const res = await onStart({ osdPath, enableLog });
        if (!res.success) {
          setLocalError(res.message || "Không thể khởi động OSD");
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-surface-border bg-surface shadow-lg">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4 bg-surface-elevated">
          <div className="flex items-center gap-2">
            <FolderSync className="h-5 w-5 text-indigo-500" />
            <h3 className="text-sm font-bold uppercase text-text-primary">
              {t("osd.title", { defaultValue: "Chấm bài trực tuyến (Online Judge / OSD)" })}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            title={t("common.close", { defaultValue: "Đóng" })}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Status Alert Banner */}
          <div
            className={`flex items-center justify-between rounded-lg border p-4 ${
              status.active
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-surface-border bg-surface-elevated text-text-muted"
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`h-3 w-3 rounded-full ${
                  status.active ? "bg-emerald-500 animate-pulse" : "bg-zinc-400"
                }`}
              />
              <div>
                <p className="text-xs font-bold uppercase">
                  {status.active
                    ? t("osd.statusActive", { defaultValue: "Đang lắng nghe nộp bài" })
                    : t("osd.statusInactive", { defaultValue: "Chấm trực tuyến đang tắt" })}
                </p>
                {status.active && (
                  <p className="text-xs text-text-muted mt-0.5 font-mono tabular-nums">
                    {t("osd.stats", {
                      defaultValue: `Hàng đợi: ${status.queueLength} bài | Đã xử lý: ${status.totalProcessed} bài`,
                      queue: status.queueLength,
                      total: status.totalProcessed,
                    })}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={isLoading}
              onClick={handleToggle}
              className={`px-4 py-2 text-xs font-bold rounded transition-colors ${
                status.active
                  ? "bg-rose-600 hover:bg-rose-500 text-white"
                  : "bg-indigo-600 hover:bg-indigo-500 text-white"
              }`}
            >
              {isLoading
                ? t("common.processing", { defaultValue: "Đang xử lý..." })
                : status.active
                ? t("osd.stopButton", { defaultValue: "Dừng lắng nghe" })
                : t("osd.startButton", { defaultValue: "Bắt đầu lắng nghe" })}
            </button>
          </div>

          {localError && (
            <div className="flex items-center gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-600 dark:text-rose-400">
              <AlertCircle className="h-4 w-4 flex-none" />
              <span>{localError}</span>
            </div>
          )}

          {/* OSD Folder Configuration */}
          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase text-text-primary">
              {t("osd.folderLabel", { defaultValue: "Thư mục nộp bài chung (OSD Shared Folder)" })}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                disabled={status.active}
                value={osdPath}
                onChange={(e) => setOsdPath(e.target.value)}
                placeholder="D:/KỳThi/Submit"
                className="flex-1 rounded border border-surface-border bg-input-bg px-3 py-2 text-xs text-text-primary focus:border-indigo-500 focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                disabled={status.active}
                onClick={handleBrowse}
                className="flex items-center gap-1.5 rounded border border-surface-border bg-surface-elevated px-3 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-40"
              >
                <FolderOpen className="h-4 w-4" />
                <span>{t("common.browse", { defaultValue: "Duyệt..." })}</span>
              </button>
            </div>
            <p className="text-[11px] text-text-muted">
              {t("osd.folderHelp", {
                defaultValue:
                  "Thí sinh nộp file bài làm vào thư mục này theo định dạng *[MãThíSinh][TênBài].EXT.",
              })}
            </p>
          </div>

          {/* Log Generation Option */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="osd-enable-log"
              disabled={status.active}
              checked={enableLog}
              onChange={(e) => setEnableLog(e.target.checked)}
              className="h-4 w-4 rounded border-surface-border text-indigo-600 focus:ring-indigo-500"
            />
            <label htmlFor="osd-enable-log" className="text-xs text-text-primary cursor-pointer">
              {t("osd.enableLogLabel", {
                defaultValue: "Tự động tạo biên bản chấm chi tiết vào thư mục OSD/Logs/[TênFile].log",
              })}
            </label>
          </div>

          {/* Guide / Documentation Accordion */}
          <div className="rounded-lg border border-surface-border bg-surface-elevated p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-text-primary">
              <Info className="h-4 w-4 text-sky-500" />
              <span>{t("osd.guideTitle", { defaultValue: "Hướng dẫn chia sẻ mạng LAN cho kỳ thi" })}</span>
            </div>
            <ul className="text-[11px] text-text-muted space-y-1.5 list-disc list-inside">
              <li>
                <strong className="text-text-primary">Windows:</strong> Chuột phải vào thư mục OSD &rarr;{" "}
                <em>Properties &rarr; Sharing &rarr; Advanced Sharing &rarr; Permissions</em> &rarr; Thêm quyền{" "}
                <span className="text-emerald-500 font-semibold">Read/Write</span> cho nhóm <em>Everyone</em>.
              </li>
              <li>
                <strong className="text-text-primary">macOS:</strong> Vào <em>System Settings &rarr; General &rarr; Sharing &rarr; File Sharing</em> &rarr; Thêm thư mục OSD và cấp quyền <em>Read & Write</em> cho Everyone.
              </li>
              <li>
                <strong className="text-text-primary">Quy ước tên file:</strong> <code>*[MãThíSinh][TênBài].cpp</code> (hoặc <code>.pas</code>, <code>.py</code>, <code>.c</code>). Ví dụ: <code>[HS01][SUM].cpp</code>, <code>001[Mon][BAI1].pas</code>.
              </li>
            </ul>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex justify-end gap-3 border-t border-surface-border bg-surface-elevated px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-surface-border bg-input-bg px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover transition-colors"
          >
            {t("common.close", { defaultValue: "Đóng" })}
          </button>
        </div>
      </div>
    </div>
  );
}
