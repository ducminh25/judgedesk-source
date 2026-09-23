import React from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isMacOS } from "../features/shortcuts/shortcuts.js";
import type { HostStatus } from "../types.js";

export interface InstallUpdateDialogProps {
  show: boolean;
  updateRequiresRestart: boolean;
  updateRestartError: string;
  isInstallingUpdate: boolean;
  hostStatus: HostStatus | null;
  onClose: () => void;
  onRestart: () => Promise<void>;
  onInstall: () => Promise<void>;
}

export default function InstallUpdateDialog({
  show,
  updateRequiresRestart,
  updateRestartError,
  isInstallingUpdate,
  hostStatus,
  onClose,
  onRestart,
  onInstall,
}: InstallUpdateDialogProps) {
  const { t } = useTranslation();

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-surface-border bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated px-5 py-4">
          <h3 className="text-sm font-bold text-text-primary">
            {updateRequiresRestart
              ? t("updates.restartNow")
              : t("updates.installTitle")}
          </h3>
          {!isInstallingUpdate && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-text-muted hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="p-5 text-xs text-text-muted">
          {updateRequiresRestart
            ? t("updates.restartRequired")
            : t("updates.installMessage")}
          {updateRestartError && (
            <p className="mt-2 text-rose-500">
              {updateRestartError}
              {updateRestartError.includes("failed to spawn")
                ? " " +
                  (isMacOS(hostStatus?.platform)
                    ? t("updates.relaunchFailedHintMac")
                    : t("updates.relaunchFailedHintWindows"))
                : (isMacOS(hostStatus?.platform)
                  ? " " + t("updates.relaunchGenericHintMac")
                  : "")}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3 border-t border-surface-border bg-surface-elevated px-5 py-4">
          {updateRequiresRestart ? (
            <button
              type="button"
              disabled={isInstallingUpdate}
              onClick={() => void onRestart()}
              className="rounded bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60"
            >
              {isInstallingUpdate
                ? t("updates.restarting")
                : t("updates.restartNow")}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={isInstallingUpdate}
                onClick={onClose}
                className="rounded border border-surface-border bg-input-bg px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={isInstallingUpdate}
                onClick={() => void onInstall()}
                className="rounded bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60"
              >
                {isInstallingUpdate
                  ? t("updates.installing")
                  : t("updates.installNow")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
