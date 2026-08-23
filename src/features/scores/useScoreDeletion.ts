import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JudgeResultsAction } from "../judging/judge-results.js";

export type PendingScoreDeletion =
  | { type: "selected"; contestantNames: string[]; problemNames: string[] }
  | { type: "result"; contestantName: string; problemName: string }
  | { type: "problem"; problemName: string }
  | { type: "contestant"; contestantName: string };

export interface UseScoreDeletionOptions {
  dispatchResults: (action: JudgeResultsAction) => void;
  isLocked: () => boolean;
}

export function useScoreDeletion({
  dispatchResults,
  isLocked,
}: UseScoreDeletionOptions) {
  const { t } = useTranslation();
  const [pendingScoreDeletion, setPendingScoreDeletion] = useState<PendingScoreDeletion | null>(null);

  const pendingScoreDeletionDescription = useMemo(() => {
    if (!pendingScoreDeletion) return "";
    if (pendingScoreDeletion.type === "selected") {
      return t("actions.confirmDeleteSelectedMessage", {
        contestants: pendingScoreDeletion.contestantNames.length,
        problems: pendingScoreDeletion.problemNames.length,
      });
    }
    if (pendingScoreDeletion.type === "result") {
      return t("actions.confirmDeleteResultMessage", {
        contestant: pendingScoreDeletion.contestantName,
        problem: pendingScoreDeletion.problemName,
      });
    }
    if (pendingScoreDeletion.type === "problem") {
      return t("actions.confirmDeleteProblemMessage", { problem: pendingScoreDeletion.problemName });
    }
    return t("actions.confirmDeleteContestantMessage", { contestant: pendingScoreDeletion.contestantName });
  }, [pendingScoreDeletion, t]);

  const confirmScoreDeletion = () => {
    const request = pendingScoreDeletion;
    if (!request || isLocked()) return;
    if (request.type === "selected") {
      dispatchResults({
        type: "delete_selected",
        contestantNames: request.contestantNames,
        problemNames: request.problemNames,
      });
    } else if (request.type === "result") {
      dispatchResults({
        type: "delete_result",
        contestantName: request.contestantName,
        problemName: request.problemName,
      });
    } else if (request.type === "problem") {
      dispatchResults({ type: "delete_problem", problemName: request.problemName });
    } else {
      dispatchResults({ type: "delete_contestant", contestantName: request.contestantName });
    }
    setPendingScoreDeletion(null);
  };

  const cancelScoreDeletion = () => {
    setPendingScoreDeletion(null);
  };

  return {
    pendingScoreDeletion,
    setPendingScoreDeletion,
    pendingScoreDeletionDescription,
    confirmScoreDeletion,
    cancelScoreDeletion,
  };
}
