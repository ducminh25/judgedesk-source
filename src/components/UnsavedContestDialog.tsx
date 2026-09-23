import { useEffect } from "react";
import { Save, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  isSaving: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export default function UnsavedContestDialog({ isSaving, onCancel, onDiscard, onSave }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isSaving, onCancel]);
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-contest-title"
        aria-describedby="unsaved-contest-message"
        className="w-full max-w-md overflow-hidden rounded-lg border border-surface-border bg-surface shadow-lg"
      >
        <div className="flex items-start gap-3 border-b border-surface-border bg-surface-elevated px-5 py-4">
          <TriangleAlert className="mt-0.5 h-5 w-5 flex-none text-amber-500" />
          <div>
            <h2 id="unsaved-contest-title" className="text-sm font-bold text-text-primary">
              {t("contest.saveChangesTitle")}
            </h2>
            <p id="unsaved-contest-message" className="mt-1 text-xs leading-5 text-text-muted">
              {t("contest.saveChangesMessage")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-5 py-4">
          <button
            type="button"
            disabled={isSaving}
            onClick={onCancel}
            className="rounded border border-surface-border bg-input-bg px-3 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={onDiscard}
            className="rounded border border-rose-300 bg-surface px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/30"
          >
            {t("contest.discard")}
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={onSave}
            className="flex items-center gap-2 rounded bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? t("contest.saving") : t("contest.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
