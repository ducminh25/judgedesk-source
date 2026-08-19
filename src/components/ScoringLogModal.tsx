import { useEffect } from "react";
import { FileText, X } from "lucide-react";
import { ContestantResult } from "../types";
import { useTranslation } from "react-i18next";
import { formatCompileError } from "../features/judging/compile-diagnostics";

interface Props {
  title: string;
  contestants: ContestantResult[];
  problemName?: string;
  contestantName?: string;
  onClose: () => void;
}

export default function ScoringLogModal({
  title,
  contestants,
  problemName,
  contestantName,
  onClose,
}: Props) {
  const { t } = useTranslation();

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

  const rows = contestants
    .filter(
      (contestant) =>
        !contestantName || contestant.contestantName === contestantName,
    )
    .flatMap((contestant) =>
      contestant.problems
        .filter(
          (problem) =>
            !problemName ||
            problem.problemName.toLowerCase() === problemName.toLowerCase(),
        )
        .flatMap((problem) => {
          const compileResult =
            problem.compileStatus === "SKIPPED"
              ? t("judgingDetails.skipped")
              : problem.compileStatus === "OK"
                ? t("judgingDetails.compilationSuccess")
                : formatCompileError(problem.compileError, t);

          return [
            {
              candidate: contestant.contestantName,
              problem: problem.problemName,
              test: t("judgingDetails.compilation"),
              status: problem.compileStatus,
              time:
                problem.compileTime == null
                  ? ""
                  : `${(problem.compileTime / 1000).toFixed(3)} ${t("scoringLog.seconds")}`,
              score: "",
              result: compileResult,
            },
            ...problem.testCases.map((test) => ({
              candidate: contestant.contestantName,
              problem: problem.problemName,
              test: test.name,
              status: test.status,
              time: `${(test.executionTime / 1000).toFixed(3)} ${t("scoringLog.seconds")}`,
              score: String(test.score),
              result:
                test.checkerMessage ||
                test.errorDetail ||
                t(`verdicts.${test.status}`, { defaultValue: test.status }),
            })),
          ];
        }),
    );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-surface-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4 bg-surface-elevated">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-sky-500 dark:text-sky-400" />
            <h3 className="text-xs font-bold uppercase text-text-primary">
              {title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-surface">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface-elevated text-[10px] uppercase text-text-muted">
              <tr>
                <th className="border-b border-surface-border px-4 py-3">
                  {t("scoringLog.candidate")}
                </th>
                <th className="border-b border-surface-border px-4 py-3">
                  {t("scoringLog.problem")}
                </th>
                <th className="border-b border-surface-border px-4 py-3">
                  {t("scoringLog.test")}
                </th>
                <th className="border-b border-surface-border px-4 py-3">
                  {t("scoringLog.status")}
                </th>
                <th className="border-b border-surface-border px-4 py-3">
                  {t("scoringLog.time")}
                </th>
                <th className="border-b border-surface-border px-4 py-3">
                  {t("scoringLog.score")}
                </th>
                <th className="border-b border-surface-border px-4 py-3">
                  {t("scoringLog.results")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {rows.map((row, index) => (
                <tr
                  key={`${row.candidate}-${row.problem}-${row.test}-${index}`}
                  className="hover:bg-surface-hover transition-colors"
                >
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-text-primary">
                    {row.candidate}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-text-primary">
                    {row.problem}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-text-muted">
                    {row.test}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-text-primary">
                    {row.status}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-text-muted">
                    {row.time}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-text-primary">
                    {row.score}
                  </td>
                  <td className="max-w-xl px-4 py-2.5 font-mono text-text-muted">
                    {row.result}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-16 text-center text-text-muted"
                  >
                    {t("scoringLog.noDetails")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
