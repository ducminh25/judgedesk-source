import { useEffect } from "react";
import { FileText, RefreshCw, Settings2, Trash2 } from "lucide-react";
import type { ScoreboardActionTarget } from "../features/scoreboard/Scoreboard";
import { useTranslation } from "react-i18next";

interface Props {
  target: ScoreboardActionTarget;
  mutationsLocked: boolean;
  onClose: () => void;
  onConfig: () => void;
  onDelete: () => void;
  onDetails: () => void;
  onRegrade: () => void;
}

const menuButton =
  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40";

export default function EntityActionMenu({
  target,
  mutationsLocked,
  onClose,
  onConfig,
  onDelete,
  onDetails,
  onRegrade,
}: Props) {
  const { t } = useTranslation();
  const deleteDisabled = mutationsLocked || !target.hasResults;
  const regradeDisabled = mutationsLocked || !target.canRegrade;
  const detailsDisabled = !target.hasResults;
  const unavailableReason = mutationsLocked
    ? t("actions.unavailableWhileBusy")
    : t("actions.noResults");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <>
      <button
        className="fixed inset-0 z-[60] cursor-default"
        onClick={onClose}
        aria-label={t("actions.closeMenu")}
      />
      <div
        role="menu"
        className="fixed z-[61] w-52 overflow-hidden rounded-md border border-surface-border-strong bg-surface-elevated py-1 shadow-2xl"
        style={{ left: target.x, top: target.y }}
      >
        {target.type === "problem" && (
          <>
            <button
              type="button"
              onClick={onConfig}
              className={menuButton}
            >
              <Settings2 className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
              {t("actions.configProblem")}
            </button>
            <div className="my-1 border-t border-surface-border" />
          </>
        )}
        <button
          type="button"
          disabled={deleteDisabled}
          onClick={onDelete}
          title={deleteDisabled ? unavailableReason : undefined}
          className={menuButton}
        >
          <Trash2 className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" />
          {t("actions.deleteScore")}
        </button>
        <button
          type="button"
          disabled={regradeDisabled}
          onClick={onRegrade}
          title={regradeDisabled ? (mutationsLocked ? t("actions.unavailableWhileBusy") : t("actions.missingData")) : undefined}
          className={menuButton}
        >
          <RefreshCw className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
          {t("actions.regrade")}
        </button>
        <button
          type="button"
          disabled={detailsDisabled}
          onClick={onDetails}
          title={detailsDisabled ? t("actions.noResults") : undefined}
          className={menuButton}
        >
          <FileText className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
          {t("actions.details")}
        </button>
      </div>
    </>
  );
}
