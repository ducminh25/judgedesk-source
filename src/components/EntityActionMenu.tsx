import { FileText, RefreshCw, Settings2, Trash2 } from "lucide-react";
import type { ScoreboardActionTarget } from "../features/scoreboard/Scoreboard";
import { useTranslation } from "react-i18next";

interface Props {
  target: ScoreboardActionTarget;
  isJudging: boolean;
  onClose: () => void;
  onConfig: () => void;
  onDelete: () => void;
  onDetails: () => void;
  onRegrade: () => void;
}

export default function EntityActionMenu({
  target,
  isJudging,
  onClose,
  onConfig,
  onDelete,
  onDetails,
  onRegrade,
}: Props) {
  const { t } = useTranslation();
  return (
    <>
      <button
        className="fixed inset-0 z-[60] cursor-default"
        onClick={onClose}
        aria-label={t("actions.closeMenu")}
      />
      <div
        className="fixed z-[61] w-44 overflow-hidden rounded-md border border-surface-border-strong bg-surface-elevated py-1 shadow-2xl"
        style={{ left: target.x, top: target.y }}
      >
        {target.type === "problem" && (
          <button
            onClick={onConfig}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary hover:bg-surface-hover transition-colors"
          >
            <Settings2 className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />{" "}
            {t("actions.configProblem")}
          </button>
        )}
        <button
          onClick={onDelete}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary hover:bg-surface-hover transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" />{" "}
          {t("actions.deleteScore")}
        </button>
        <button
          disabled={isJudging}
          onClick={onRegrade}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary hover:bg-surface-hover disabled:opacity-40 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />{" "}
          {t("actions.regrade")}
        </button>
        <button
          onClick={onDetails}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary hover:bg-surface-hover transition-colors"
        >
          <FileText className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />{" "}
          {t("actions.details")}
        </button>
      </div>
    </>
  );
}
