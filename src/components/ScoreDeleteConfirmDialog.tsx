import { useEffect } from "react";
import { Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  description: string;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ScoreDeleteConfirmDialog({
  description,
  disabled = false,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disabled) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [disabled, onCancel]);
  return (
    <div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-score-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-surface-border bg-surface shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-surface-border bg-surface-elevated px-5 py-4">
          <TriangleAlert className="mt-0.5 h-5 w-5 flex-none text-rose-500" />
          <div>
            <h2 id="delete-score-title" className="text-sm font-bold text-text-primary">
              {t("actions.confirmDeleteTitle")}
            </h2>
            <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-surface-border bg-input-bg px-3 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onConfirm}
            className="flex items-center gap-2 rounded bg-rose-600 px-3 py-2 text-xs font-bold text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("actions.confirmDelete")}
          </button>
        </div>
      </div>
    </div>
  );
}
