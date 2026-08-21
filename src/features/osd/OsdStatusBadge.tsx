import { FolderSync } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OsdStatusState } from "./useOsdSession";

interface Props {
  status: OsdStatusState;
  onClick: () => void;
  disabled?: boolean;
}

export default function OsdStatusBadge({ status, onClick, disabled }: Props) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={
        status.active
          ? t("osd.activeTooltip", {
              defaultValue: `Chấm trực tuyến đang BẬT. Hàng đợi: ${status.queueLength} bài. Nhấn để xem cài đặt (F8).`,
              queue: status.queueLength,
            })
          : t("osd.inactiveTooltip", {
              defaultValue: "Chấm bài trực tuyến qua mạng LAN (OSD) - Phím tắt F8",
            })
      }
      className={`flex h-9 flex-none items-center gap-2 rounded border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        status.active
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
          : "border-surface-border bg-surface-elevated text-text-primary hover:bg-surface-hover"
      }`}
    >
      <div className="relative flex items-center justify-center">
        <FolderSync
          className={`h-4 w-4 ${status.active ? "text-emerald-500 animate-spin-slow" : "text-text-muted"}`}
        />
        {status.active && (
          <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
        )}
      </div>

      <span className="hidden sm:inline">
        {t("osd.badgeLabel", { defaultValue: "OSD" })}
      </span>

      {status.active && status.queueLength > 0 && (
        <span className="rounded-full bg-emerald-500 px-1.5 py-0.2 text-[10px] font-bold text-white leading-tight">
          {status.queueLength}
        </span>
      )}
    </button>
  );
}
