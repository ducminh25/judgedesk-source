import { Archive, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function ContestSaveProgressDialog() {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="contest-save-progress-title"
        className="w-full max-w-sm rounded-lg border border-surface-border bg-surface p-5 shadow-lg"
      >
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 flex-none items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500">
            <Archive className="h-5 w-5" />
            <LoaderCircle className="absolute h-10 w-10 animate-spin opacity-60" />
          </div>
          <div>
            <h2 id="contest-save-progress-title" className="text-sm font-bold text-text-primary">
              {t("contest.saving")}
            </h2>
            <p className="mt-1 text-xs text-text-muted">{t("contest.savingDescription")}</p>
          </div>
        </div>
        <div className="mt-5 h-1.5 overflow-hidden rounded-sm bg-surface-hover">
          <div className="h-full w-1/2 animate-pulse rounded-sm bg-indigo-500" />
        </div>
      </div>
    </div>
  );
}
