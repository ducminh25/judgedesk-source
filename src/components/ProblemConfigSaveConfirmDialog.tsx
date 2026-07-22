import { Save, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  disabled?: boolean;
  problemName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ProblemConfigSaveConfirmDialog({
  disabled = false,
  problemName,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-problem-config-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-surface-border bg-surface shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-surface-border bg-surface-elevated px-5 py-4">
          <TriangleAlert className="mt-0.5 h-5 w-5 flex-none text-amber-500" />
          <div>
            <h2 id="confirm-problem-config-title" className="text-sm font-bold text-text-primary">
              {t("problemConfig.confirmSaveTitle")}
            </h2>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              {t("problemConfig.confirmSaveMessage", { problem: problemName })}
            </p>
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
            className="flex items-center gap-2 rounded bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {t("problemConfig.saveAndClear")}
          </button>
        </div>
      </div>
    </div>
  );
}
