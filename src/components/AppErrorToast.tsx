import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, ArrowRight, Info, X } from "lucide-react";
import type { AppError } from "../features/errors/app-error.js";
import { useTranslation } from "react-i18next";

interface Props {
  error: AppError | null;
  onClose: () => void;
  autoDismissMs?: number;
}

export default function AppErrorToast({
  error,
  onClose,
  autoDismissMs = 8000,
}: Props) {
  const { t } = useTranslation();
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!error) return;

    if (error.severity === "info" || error.severity === "warning") {
      if (isPaused) {
        if (timerRef.current) clearTimeout(timerRef.current);
        return;
      }

      timerRef.current = setTimeout(() => {
        onClose();
      }, autoDismissMs);

      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }
  }, [error, isPaused, onClose, autoDismissMs]);

  if (!error) return null;

  const isWarning = error.severity === "warning";
  const isInfo = error.severity === "info";

  const IconComponent = isWarning
    ? AlertTriangle
    : isInfo
      ? Info
      : AlertCircle;

  const containerClasses = isWarning
    ? "border-amber-500/40 bg-amber-50 dark:bg-amber-950 text-amber-900 dark:text-amber-100"
    : isInfo
      ? "border-sky-500/40 bg-sky-50 dark:bg-sky-950 text-sky-900 dark:text-sky-100"
      : "border-rose-500/40 bg-rose-50 dark:bg-rose-950 text-rose-900 dark:text-rose-100";

  const iconClasses = isWarning
    ? "text-amber-600 dark:text-amber-400"
    : isInfo
      ? "text-sky-600 dark:text-sky-400"
      : "text-rose-600 dark:text-rose-400";

  const actionBoxClasses = isWarning
    ? "bg-amber-100/70 dark:bg-amber-900/40 border-amber-300 dark:border-amber-800/60 text-amber-800 dark:text-amber-200"
    : isInfo
      ? "bg-sky-100/70 dark:bg-sky-900/40 border-sky-300 dark:border-sky-800/60 text-sky-800 dark:text-sky-200"
      : "bg-rose-100/70 dark:bg-rose-900/40 border-rose-300 dark:border-rose-800/60 text-rose-800 dark:text-rose-200";

  return (
    <aside
      role="alert"
      aria-live="assertive"
      aria-label={error.title}
      className="fixed bottom-10 right-4 z-50 max-w-md animate-in fade-in slide-in-from-bottom-5 duration-200"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div
        className={`flex flex-col gap-2 rounded-lg border p-4 shadow-lg transition-all ${containerClasses}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <IconComponent className={`h-5 w-5 flex-none ${iconClasses}`} />
            <h4 className="text-sm font-bold leading-tight">
              {error.title}
            </h4>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-none -mr-1 -mt-1 rounded p-1 opacity-70 transition-opacity hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10"
            title={t("common.close", "Đóng")}
            aria-label={t("common.close", "Đóng")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error.reason && (
          <p className="text-xs opacity-90 leading-relaxed pl-7">
            {error.reason}
          </p>
        )}

        {error.action && (
          <div className={`mt-1 flex items-start gap-2 rounded border px-3 py-2 text-xs font-medium ${actionBoxClasses}`}>
            <ArrowRight className="h-3.5 w-3.5 flex-none mt-0.5" />
            <span className="flex-1">{error.action}</span>
          </div>
        )}

        {error.actionLabel && error.onAction && (
          <div className="mt-1 flex justify-end gap-2 pl-7">
            <button
              type="button"
              onClick={() => {
                error.onAction?.();
                onClose();
              }}
              className="rounded bg-text-primary px-3 py-1 text-xs font-semibold text-surface hover:opacity-90 transition-opacity"
            >
              {error.actionLabel}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
