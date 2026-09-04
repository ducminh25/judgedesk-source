import React, { useState, useMemo, useEffect } from "react";
import {
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  AlertCircle,
} from "lucide-react";
import { ProblemResult } from "../types";
import { useTranslation } from "react-i18next";
import { formatCompileError } from "../features/judging/compile-diagnostics";
import { formatScore } from "../../shared/rational";

interface Props {
  data: ProblemResult;
  contestantName: string;
  onClose: () => void;
}

type ResultFilter = "ALL" | "CORRECT" | "INCORRECT" | "PARTIAL";

export default function JudgingDetailsModal({
  data,
  contestantName,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<ResultFilter>("ALL");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);
  const filters: Array<{ value: ResultFilter; label: string }> = [
    { value: "ALL", label: t("judgingDetails.filters.all") },
    { value: "CORRECT", label: t("judgingDetails.filters.correct") },
    { value: "INCORRECT", label: t("judgingDetails.filters.incorrect") },
    { value: "PARTIAL", label: t("judgingDetails.filters.partial") },
  ];

  const getStatusDisplay = (st: string) => {
    switch (st) {
      case "AC":
        return {
          col: "text-emerald-600 dark:text-emerald-400",
          el: <CheckCircle2 className="w-3.5 h-3.5" />,
        };
      case "WA":
        return {
          col: "text-rose-600 dark:text-rose-400",
          el: <XCircle className="w-3.5 h-3.5" />,
        };
      case "PE":
        return {
          col: "text-blue-600 dark:text-blue-400",
          el: <XCircle className="w-3.5 h-3.5" />,
        };
      case "TLE":
        return {
          col: "text-amber-600 dark:text-amber-400",
          el: <Clock className="w-3.5 h-3.5" />,
        };
      case "MLE":
        return {
          col: "text-amber-600 dark:text-amber-500",
          el: <AlertTriangle className="w-3.5 h-3.5" />,
        };
      case "RE":
      case "OLE":
      case "JE":
        return {
          col: "text-slate-600 dark:text-slate-400",
          el: <AlertTriangle className="w-3.5 h-3.5" />,
        };
      case "CE":
        return {
          col: "text-violet-600 dark:text-violet-400",
          el: <AlertTriangle className="w-3.5 h-3.5" />,
        };
      default:
        return {
          col: "text-text-muted",
          el: <AlertCircle className="w-3.5 h-3.5" />,
        };
    }
  };

  const filteredTests = useMemo(() => {
    return data.testCases.filter((tc) => {
      if (filter === "ALL") return true;
      if (filter === "CORRECT") return tc.status === "AC";
      if (filter === "INCORRECT")
        return tc.status !== "AC" && tc.status !== "PE";
      if (filter === "PARTIAL") return tc.status === "PE" || tc.status === "PARTIAL";
      return true;
    });
  }, [data.testCases, filter]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface border border-surface-border rounded-lg w-full max-w-4xl shadow-2xl flex flex-col max-h-[95vh]">
        <div className="flex items-center justify-between p-4 border-b border-surface-border">
          <div className="flex flex-col">
            <h3 className="text-text-primary font-bold tracking-wider uppercase text-[11px]">
              {t("judgingDetails.title")}:{" "}
              <span className="text-indigo-600 dark:text-indigo-400">
                {contestantName}
              </span>
            </h3>
            <span className="text-text-muted text-2xs font-mono mt-0.5">
              {t("judgingDetails.problem")}: {data.problemName} |{" "}
              {t("judgingDetails.overall")}: {data.summary.status} |{" "}
              {t("judgingDetails.score")}: {formatScore(data.summary.score)}/
              {formatScore(data.summary.maxScore)} |{" "}
              {t("judgingDetails.passedTests")}: {data.summary.passed}/{data.summary.total}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label={t("common.close")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-0 flex-1 overflow-y-auto flex flex-col font-sans text-xs bg-surface">
          {/* Compilation section */}
          {data.compileStatus === "CE" ? (
            <div className="bg-violet-50 dark:bg-violet-950/20 p-5 border-b border-surface-border">
              <h4 className="flex items-center gap-2 text-violet-600 dark:text-violet-400 font-bold uppercase tracking-widest text-[10px] mb-2">
                <AlertTriangle className="w-4 h-4" />{" "}
                {t("judgingDetails.compilationFailure")}
              </h4>
              <pre className="font-mono text-2xs text-violet-700 dark:text-violet-300 whitespace-pre-wrap overflow-x-auto">
                {formatCompileError(data.compileError, t)}
              </pre>
            </div>
          ) : (
            <div className="bg-surface-elevated p-4 flex items-center justify-between border-b border-surface-border">
              <div className="flex gap-2 items-center text-text-muted text-2xs">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-500" />
                <span>
                  {t("judgingDetails.compiledSuccessfully")}{" "}
                  {data.compileTime?.toFixed(2)}ms
                </span>
              </div>

              <div className="flex border border-surface-border-strong rounded bg-input-bg p-0.5 mt-2 sm:mt-0">
                {filters.map((item) => (
                  <button
                    key={item.value}
                    onClick={() => setFilter(item.value)}
                    className={`text-2xs font-semibold px-3 py-1 rounded transition ${filter === item.value ? "bg-surface-elevated text-text-primary shadow" : "text-text-muted hover:text-text-primary"}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Test cases list */}
          <div className="divide-y divide-surface-border bg-input-bg">
            {filteredTests.map((tc, idx) => {
              const dspl = getStatusDisplay(tc.status);
              return (
                <div
                  key={idx}
                  className="p-4 hover:bg-surface-hover transition flex flex-col"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono font-bold text-text-primary text-[11px]">
                      {tc.name}
                    </span>
                    <div className="flex items-center gap-4">
                      <span className="font-mono text-text-muted text-2xs">
                        {(tc.executionTime / 1000).toFixed(4)}
                        {t("judgingDetails.seconds")}
                      </span>
                      {tc.peakMemory !== undefined && (
                        <span className="font-mono text-text-muted text-2xs">
                          {(tc.peakMemory / 1024).toFixed(2)} MB
                        </span>
                      )}
                      <span className="text-text-muted font-bold text-[10px]">
                        {t("judgingDetails.score")}:{" "}
                        {formatScore(Number(tc.score))}
                      </span>
                      <div
                        className={`flex items-center gap-1.5 font-bold text-[10px] uppercase tracking-wider w-24 ${dspl.col}`}
                      >
                        {dspl.el} {tc.status}
                      </div>
                    </div>
                  </div>
                  {tc.checkerMessage && (
                    <div className="bg-indigo-50 dark:bg-indigo-950/10 border border-indigo-200 dark:border-indigo-900/30 p-2 rounded mt-1.5 text-2xs font-mono text-indigo-700 dark:text-indigo-300">
                      <strong>{t("judgingDetails.checker")}:</strong>{" "}
                      {tc.checkerMessage}
                    </div>
                  )}
                  {(tc.status === "WA" || tc.status === "PE" || (tc.expectedOutputPreview === "[Interactive Problem]" && Boolean(tc.actualOutputPreview))) && (
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      <div className="bg-surface border border-surface-border p-2 rounded font-mono text-2xs text-text-muted overflow-x-auto max-h-32 whitespace-pre-wrap">
                        <span className="block font-bold text-text-primary mb-1 border-b border-surface-border pb-1">
                          {tc.expectedOutputPreview === "[Interactive Problem]"
                            ? t("judgingDetails.interactiveProtocol")
                            : t("judgingDetails.expectedOutput")}
                        </span>
                        {tc.expectedOutputPreview || t("common.noOutput")}
                      </div>
                      <div className="bg-surface border border-surface-border p-2 rounded font-mono text-2xs text-rose-600 dark:text-rose-300 overflow-x-auto max-h-32 whitespace-pre-wrap">
                        <span className="block font-bold text-rose-700 dark:text-rose-900/60 mb-1 border-b border-surface-border pb-1">
                          {tc.expectedOutputPreview === "[Interactive Problem]"
                            ? t("judgingDetails.interactiveTranscript")
                            : t("judgingDetails.contestantOutput")}
                        </span>
                        {tc.actualOutputPreview || t("common.noOutput")}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {filteredTests.length === 0 && data.compileStatus !== "CE" && (
              <div className="text-center py-12 text-text-muted text-xs font-mono">
                {t("judgingDetails.noMatch")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
