import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../../api.js";
import {
  encodeScoreExportPayload,
  SCORE_EXPORT_CONTENT_TYPE,
} from "../../../shared/score-export-wire.js";
import {
  buildScoreExport,
  hostStatusToRunMetadata,
} from "./score-workbook-client.js";
import type { HostStatus, BatchJudgeResult } from "../../types.js";
import type { formatAppError } from "../errors/app-error.js";

export interface UseScoreboardExportOptions {
  displayedProblems: string[];
  displayedContestants: string[];
  selectedProblems: Record<string, boolean>;
  selectedContestants: Record<string, boolean>;
  problemsList: string[];
  contestantsList: string[];
  judgeResult: BatchJudgeResult | null;
  hostStatus: HostStatus | null;
  isLocked: () => boolean;
  onClearErrors: () => void;
  showError: (err: unknown, options?: Parameters<typeof formatAppError>[1]) => void;
}

export function useScoreboardExport({
  displayedProblems,
  displayedContestants,
  selectedProblems,
  selectedContestants,
  problemsList,
  contestantsList,
  judgeResult,
  hostStatus,
  isLocked,
  onClearErrors,
  showError,
}: UseScoreboardExportOptions) {
  const { t } = useTranslation();
  const [isExporting, setIsExporting] = useState(false);
  const exportOperationRef = useRef(false);

  const exportStateRef = useRef({
    displayedProblems,
    displayedContestants,
    selectedProblems,
    selectedContestants,
    problemsList,
    contestantsList,
    judgeResult,
    hostStatus,
    showError,
    t,
  });
  exportStateRef.current = {
    displayedProblems,
    displayedContestants,
    selectedProblems,
    selectedContestants,
    problemsList,
    contestantsList,
    judgeResult,
    hostStatus,
    showError,
    t,
  };

  const handleExportExcel = async () => {
    if (isLocked() || exportOperationRef.current) return;
    exportOperationRef.current = true;
    setIsExporting(true);
    onClearErrors();
    try {
      const state = exportStateRef.current;
      const isProblemSelected = (p: string) => {
        if (state.selectedProblems[p] !== undefined) return !!state.selectedProblems[p];
        const lower = p.trim().toLowerCase();
        for (const [k, v] of Object.entries(state.selectedProblems)) {
          if (k.trim().toLowerCase() === lower) return !!v;
        }
        return false;
      };
      const activeProblems = state.displayedProblems.filter(isProblemSelected);
      const effectiveProblems = activeProblems.length > 0
        ? activeProblems
        : (state.displayedProblems.length > 0
            ? state.displayedProblems
            : (state.problemsList.length > 0
                ? state.problemsList
                : (state.judgeResult ? Array.from(new Set(state.judgeResult.contestants.flatMap((c) => c.problems.map((p) => p.problemName)))) : [])));

      const isContestantSelected = (c: string) => {
        if (state.selectedContestants[c] !== undefined) return !!state.selectedContestants[c];
        const lower = c.trim().toLowerCase();
        for (const [k, v] of Object.entries(state.selectedContestants)) {
          if (k.trim().toLowerCase() === lower) return !!v;
        }
        return false;
      };
      const activeContestants = state.displayedContestants.filter(isContestantSelected);
      const effectiveContestants = activeContestants.length > 0
        ? activeContestants
        : (state.displayedContestants.length > 0
            ? state.displayedContestants
            : (state.contestantsList.length > 0
                ? state.contestantsList
                : (state.judgeResult ? state.judgeResult.contestants.map((c) => c.contestantName) : [])));

      const fallbackMetadata = hostStatusToRunMetadata(state.hostStatus);
      const scoreExport = await buildScoreExport(
        state.judgeResult ?? { success: true, contestants: [] },
        effectiveContestants,
        effectiveProblems,
        state.t,
        fallbackMetadata,
      );
      const payload = encodeScoreExportPayload(
        scoreExport.workbook,
        scoreExport.diagnosticJson,
      );
      const response = await apiFetch("/api/open-excel", {
        method: "POST",
        headers: { "Content-Type": SCORE_EXPORT_CONTENT_TYPE },
        body: payload,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(failure?.message || `HTTP ${response.status}`);
      }
      onClearErrors();
    } catch (error: any) {
      exportStateRef.current.showError(error, {
        code: "EXCEL_EXPORT_FAILED",
        title: exportStateRef.current.t("appErrors.excelExportFailed.title"),
      });
    } finally {
      exportOperationRef.current = false;
      setIsExporting(false);
    }
  };

  const handleExport = useCallback(() => {
    void handleExportExcel();
  }, []);

  return {
    isExporting,
    handleExport,
  };
}
