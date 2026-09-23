import React from "react";
import {
  Download,
  XCircle,
  Trash2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { ToolchainDescriptor } from "./useToolchains.js";
import { useTranslation } from "react-i18next";

interface Props {
  key?: React.Key;
  toolchain: ToolchainDescriptor;
  onInstall: (id: string) => void;
  onCancel: (id: string) => void;
  onUninstall: (id: string) => void;
}

export function ToolchainCard({
  toolchain,
  onInstall,
  onCancel,
  onUninstall,
}: Props) {
  const { t } = useTranslation();

  const formatSize = (bytes?: number) => {
    if (!bytes) return "0 MB";
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const getStatusMessage = () => {
    const s = toolchain.progress.status;
    switch (s) {
      case "downloading":
        return `${t("toolchains.downloading")} (${toolchain.progress.percent}%)`;
      case "extracting":
        return t("toolchains.extracting");
      case "verifying":
        return t("toolchains.verifying");
      case "failed":
        return `${t("toolchains.failed")}: ${toolchain.progress.error || ""}`;
      case "success":
        return t("toolchains.success");
      default:
        return toolchain.installed
          ? t("toolchains.installed")
          : t("toolchains.readyToInstall");
    }
  };

  const getStatusColor = () => {
    const s = toolchain.progress.status;
    if (s === "success" || (toolchain.installed && s === "idle"))
      return "text-emerald-600 dark:text-emerald-400";
    if (s === "failed") return "text-rose-600 dark:text-rose-400";
    if (s === "downloading" || s === "extracting" || s === "verifying")
      return "text-indigo-600 dark:text-indigo-400";
    return "text-text-muted";
  };

  const showProgress =
    toolchain.progress.status === "downloading" ||
    toolchain.progress.status === "extracting" ||
    toolchain.progress.status === "verifying";

  return (
    <div className="border border-surface-border bg-surface-elevated rounded-lg p-4 flex flex-col justify-between shadow-xs transition-colors">
      <div className="space-y-2">
        <div className="flex items-start justify-between">
          <div>
            <h4 className="text-sm font-bold text-text-primary flex items-center gap-2">
              {t(`languages.${toolchain.kind}`)}
              <span className="text-[10px] font-mono tabular-nums bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded font-bold">
                {toolchain.version}
              </span>
            </h4>
            <p className="text-[10px] text-text-muted mt-1 font-semibold uppercase tracking-wider">
              {toolchain.platform === "win32"
                ? t("toolchains.windows")
                : t("toolchains.macos")}{" "}
              • {toolchain.arch} • <span className="font-mono tabular-nums">{formatSize(toolchain.sizeBytes)}</span>
            </p>
          </div>
          {(toolchain.installed || toolchain.progress.status === "success") && (
            <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
          )}
        </div>

        {/* Progress bar */}
        {showProgress && (
          <div className="space-y-1.5 pt-2">
            <div className="flex justify-between text-2xs text-text-muted font-bold uppercase">
              <span>{getStatusMessage()}</span>
              <span className="font-mono tabular-nums">{toolchain.progress.percent}%</span>
            </div>
            <div className="w-full bg-input-bg border border-surface-border-strong rounded-sm h-2 overflow-hidden">
              <div
                className="bg-indigo-600 h-full transition-all duration-300"
                style={{ width: `${toolchain.progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {!showProgress && (
          <div
            className={`text-xs font-semibold flex items-center gap-1.5 ${getStatusColor()}`}
          >
            {toolchain.progress.status === "failed" ? (
              <AlertCircle className="w-4 h-4" />
            ) : null}
            <span>{getStatusMessage()}</span>
          </div>
        )}

        {toolchain.installed && toolchain.origin === "built-in" && (
          <div className="text-2xs font-semibold text-emerald-600 dark:text-emerald-400">
            {t("toolchains.registry.includedWithJudgeDesk")}
          </div>
        )}

        <div className="text-[10px] text-text-muted">
          <span className="font-bold">{t("toolchains.checksum")}:</span>{" "}
          <span className="font-mono">
            {toolchain.sha256.substring(0, 16)}...
          </span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 mt-4 pt-3 border-t border-surface-border">
        {showProgress ? (
          <button
            onClick={() => onCancel(toolchain.id)}
            className="flex items-center gap-1 px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 text-2xs font-bold uppercase tracking-wider rounded transition cursor-pointer"
          >
            <XCircle className="w-3.5 h-3.5" /> {t("toolchains.cancel")}
          </button>
        ) : toolchain.installed && toolchain.uninstallable ? (
          <button
            onClick={() => onUninstall(toolchain.id)}
            className="flex items-center gap-1 px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 text-2xs font-bold uppercase tracking-wider rounded transition cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" /> {t("toolchains.uninstall")}
          </button>
        ) : !toolchain.installed ? (
          <button
            onClick={() => onInstall(toolchain.id)}
            className="flex items-center gap-1 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-2xs font-bold uppercase tracking-wider rounded transition cursor-pointer shadow"
          >
            <Download className="w-3.5 h-3.5" /> {t("toolchains.install")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
