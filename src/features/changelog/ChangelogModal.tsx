import React, { useEffect, useMemo, useState } from "react";
import { Sparkles, X, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getChangelogForLanguage, type ChangelogRelease } from "./changelog-data.js";
import { APP_VERSION } from "../../version.js";

export interface ChangelogModalProps {
  onClose: () => void;
  initialVersion?: string;
}

export default function ChangelogModal({
  onClose,
  initialVersion = APP_VERSION,
}: ChangelogModalProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "vi" ? "vi" : "en";
  const releases = useMemo(() => getChangelogForLanguage(lang), [lang]);

  const [selectedVersion, setSelectedVersion] = useState<string>(() => {
    const found = releases.find((r) => r.version === initialVersion);
    return found ? found.version : (releases[0]?.version ?? APP_VERSION);
  });

  const activeRelease: ChangelogRelease = useMemo(() => {
    return releases.find((r) => r.version === selectedVersion) ?? releases[0];
  }, [releases, selectedVersion]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleOpenGitHub = async () => {
    const url = `https://github.com/ducminh25/judgedesk/releases/tag/v${activeRelease.version}`;
    try {
      if ("__TAURI_INTERNALS__" in window) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4">
      <div
        className="flex flex-col w-full max-w-2xl max-h-[85vh] rounded-lg border border-surface-border bg-surface shadow-lg overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-modal-title"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="changelog-modal-title"
                className="text-base font-bold text-text-primary leading-tight"
              >
                {t("changelog.modalTitle", "Có gì mới trong JudgeDesk")}
              </h2>
              <p className="text-xs text-text-muted mt-0.5">
                {t(
                  "changelog.modalSubtitle",
                  "Nhật ký các thay đổi và cải tiến của phiên bản",
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close", "Đóng")}
            className="rounded p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Version Selector Tabs */}
        <div className="flex items-center gap-1.5 px-6 py-2.5 border-b border-surface-border bg-surface-elevated/50 overflow-x-auto no-scrollbar">
          <span className="text-[11px] font-semibold text-text-muted mr-1 shrink-0">
            {t("changelog.allVersions", "Phiên bản")}:
          </span>
          {releases.map((release) => {
            const isSelected = release.version === selectedVersion;
            const isLatest = release.version === APP_VERSION;
            return (
              <button
                key={release.version}
                type="button"
                onClick={() => setSelectedVersion(release.version)}
                className={`relative px-2.5 py-1 rounded text-xs font-mono font-semibold shrink-0 transition tabular-nums ${
                  isSelected
                    ? "bg-indigo-600 text-white shadow-xs"
                    : "bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-surface-hover border border-surface-border"
                }`}
              >
                v{release.version}
                {isLatest && !isSelected && (
                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-indigo-500 align-middle" />
                )}
              </button>
            );
          })}
        </div>

        {/* Changelog Content Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 text-xs text-text-primary">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-surface-border">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-text-primary">
                  JudgeDesk v{activeRelease.version}
                </h3>
                {activeRelease.version === APP_VERSION && (
                  <span className="rounded bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 text-[10px] font-bold text-indigo-600 dark:text-indigo-400">
                    {t("changelog.currentVersion", "Hiện tại")}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-text-muted mt-0.5 font-mono tabular-nums">
                {t("changelog.releaseDate", { date: activeRelease.date })}
              </p>
            </div>

            <button
              type="button"
              onClick={handleOpenGitHub}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300 transition"
            >
              <span>{t("changelog.viewFullNotes", "Xem trên GitHub")}</span>
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>

          {activeRelease.sections.map((section, idx) => (
            <div key={idx} className="space-y-2.5">
              <h4 className="text-xs font-bold text-text-primary uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
                {section.title}
              </h4>
              <ul className="space-y-2 pl-4 list-disc marker:text-indigo-500 dark:marker:text-indigo-400 text-text-primary">
                {section.items.map((item, itemIdx) => (
                  <li key={itemIdx} className="leading-relaxed pl-1 text-xs">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-surface-border bg-surface-elevated px-6 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-indigo-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-indigo-500 shadow-xs transition"
          >
            {t("changelog.gotIt", "Đã hiểu")}
          </button>
        </div>
      </div>
    </div>
  );
}
