import {
  useMemo,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  ArrowUpDown,
  Download,
  EllipsisVertical,
  Terminal,
} from "lucide-react";
import type { BatchJudgeResult, ProblemResult } from "../../types";
import { useTranslation } from "react-i18next";

export interface ScoreboardActionTarget {
  type: "problem" | "contestant";
  name: string;
  x: number;
  y: number;
}

interface Props {
  allContestants: string[];
  contestants: string[];
  contestantSort: "default" | "asc" | "desc" | "score";
  problems: string[];
  result: BatchJudgeResult | null;
  selectedContestants: Record<string, boolean>;
  selectedProblems: Record<string, boolean>;
  setContestantSort: Dispatch<
    SetStateAction<"default" | "asc" | "desc" | "score">
  >;
  setSelectedContestants: Dispatch<SetStateAction<Record<string, boolean>>>;
  setSelectedProblems: Dispatch<SetStateAction<Record<string, boolean>>>;
  onExport: () => void;
  onOpenActions: (target: ScoreboardActionTarget) => void;
  onOpenDetails: (contestant: string, problem: ProblemResult) => void;
}

export default function Scoreboard({
  allContestants,
  contestants,
  contestantSort,
  problems,
  result,
  selectedContestants,
  selectedProblems,
  setContestantSort,
  setSelectedContestants,
  setSelectedProblems,
  onExport,
  onOpenActions,
  onOpenDetails,
}: Props) {
  const { t } = useTranslation();
  const resultsByContestant = useMemo(
    () =>
      new Map(
        (result?.contestants || []).map((contestant) => [
          contestant.contestantName,
          contestant,
        ]),
      ),
    [result],
  );
  const selectedProblemNames = useMemo(
    () =>
      new Set(
        Object.keys(selectedProblems)
          .filter((problem) => selectedProblems[problem])
          .map((name) => name.toLowerCase()),
      ),
    [selectedProblems],
  );

  const renderCell = (contestantName: string, problemName: string) => {
    const problem = resultsByContestant
      .get(contestantName)
      ?.problems.find(
        (item) => item.problemName.toLowerCase() === problemName.toLowerCase(),
      );
    if (!problem) {
      return (
        <td
          key={problemName}
          className="p-3 text-center border-l border-surface-border text-surface-border-strong"
        >
          -
        </td>
      );
    }

    let displayText: ReactNode = problem.summary.score;
    let colorClass = "text-text-muted";
    if (
      problem.compileStatus === "SKIPPED" &&
      problem.compileError === "not_found"
    ) {
      displayText = t("scoreboard.notFound");
      colorClass = "text-text-muted bg-surface-hover";
    } else if (problem.compileStatus === "CE") {
      displayText = "CE";
      colorClass =
        "text-rose-600 dark:text-rose-500 font-bold bg-rose-100 dark:bg-rose-950/20";
    } else if (problem.summary.status === "AC") {
      colorClass =
        "text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-100 dark:bg-emerald-950/20";
    } else if (problem.summary.status === "PARTIAL") {
      colorClass =
        "text-amber-600 dark:text-yellow-400 font-bold bg-amber-100 dark:bg-yellow-950/20";
    } else {
      colorClass =
        "text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/10";
    }

    return (
      <td
        key={problemName}
        onDoubleClick={() =>
          problem.compileStatus !== "SKIPPED" &&
          onOpenDetails(contestantName, problem)
        }
        className={`p-3 text-center border-l border-surface-border cursor-pointer hover:brightness-95 dark:hover:brightness-110 transition ${colorClass}`}
        title={t("scoreboard.resultStatus", {
          status: problem.summary.status,
          compileStatus: problem.compileStatus,
        })}
      >
        {displayText}
      </td>
    );
  };

  return (
    <main className="flex-1 overflow-hidden p-6 w-full flex flex-col relative bg-surface">
      <div className="flex-1 flex flex-col min-w-0 bg-surface rounded-lg border border-surface-border shadow-xl shadow-black/5 dark:shadow-black/80 overflow-hidden">
        <div className="h-12 border-b border-surface-border bg-surface-elevated flex flex-col justify-center px-4">
          <div className="flex items-center justify-between">
            <div className="text-2xs text-text-muted">
              {t("scoreboard.description")}
            </div>
            {result?.contestants.some(
              (contestant) => contestant.problems.length > 0,
            ) && (
              <button
                onClick={onExport}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold uppercase tracking-wider rounded transition"
              >
                <Download className="w-3 h-3" /> {t("scoreboard.export")}
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-surface">
          {allContestants.length === 0 && problems.length === 0 ? (
            <div className="w-full h-full min-h-[400px] flex flex-col items-center justify-center text-center text-text-muted">
              <Terminal className="w-8 h-8 text-surface-border-strong mb-3" />
              <p className="text-xs max-w-sm">
                {t("scoreboard.noContestants")}
              </p>
            </div>
          ) : (
            <table className="w-full text-xs text-left relative border-collapse">
              <thead className="bg-surface-elevated sticky top-0 z-20 shadow-sm border-b border-surface-border">
                <tr>
                  <th className="px-4 py-3 font-semibold text-text-primary whitespace-nowrap min-w-[220px] border-b border-surface-border sticky left-0 bg-surface-elevated z-30">
                    <div className="flex items-center gap-3 justify-between">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={
                            allContestants.length > 0 &&
                            allContestants.every(
                              (name) => selectedContestants[name],
                            )
                          }
                          onChange={(event) =>
                            setSelectedContestants((previous) => ({
                              ...previous,
                              ...Object.fromEntries(
                                allContestants.map((name) => [
                                  name,
                                  event.target.checked,
                                ]),
                              ),
                            }))
                          }
                          className="w-4 h-4 bg-input-bg border-surface-border-strong rounded text-indigo-500 cursor-pointer"
                          title={t("scoreboard.selectAllContestants")}
                        />
                        <span>{t("scoreboard.contestants")}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setContestantSort((previous) =>
                            previous === "default"
                              ? "asc"
                              : previous === "asc"
                                ? "desc"
                                : "default",
                          )
                        }
                        className={`p-1 hover:bg-surface-hover rounded transition ${contestantSort !== "default" && contestantSort !== "score" ? "text-indigo-500 dark:text-indigo-400 font-bold" : "text-text-muted"}`}
                        title={t("scoreboard.sortAlphabetically")}
                      >
                        <ArrowUpDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </th>
                  {problems.map((problemName) => (
                    <th
                      key={problemName}
                      className="px-4 py-3 font-semibold text-text-primary whitespace-nowrap text-center border-l border-b border-surface-border transition group hover:bg-surface-hover"
                    >
                      <div className="flex items-center justify-center gap-2">
                        <input
                          type="checkbox"
                          checked={!!selectedProblems[problemName]}
                          onChange={(event) =>
                            setSelectedProblems((previous) => ({
                              ...previous,
                              [problemName]: event.target.checked,
                            }))
                          }
                          className="w-4 h-4 bg-input-bg border-surface-border-strong rounded text-indigo-500 cursor-pointer"
                          title={t("scoreboard.selectProblem")}
                        />
                        <span>{problemName}</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            onOpenActions({
                              type: "problem",
                              name: problemName,
                              x: Math.min(rect.left, window.innerWidth - 190),
                              y: rect.bottom + 6,
                            });
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-surface-hover hover:text-text-primary"
                          title={t("scoreboard.actionsFor", {
                            name: problemName,
                          })}
                        >
                          <EllipsisVertical className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </th>
                  ))}
                  <th className="px-4 py-3 font-semibold text-indigo-700 dark:text-indigo-300 whitespace-nowrap text-center border-l border-b border-surface-border sticky right-0 bg-total-column z-20">
                    <div className="flex items-center justify-center gap-2">
                      <input
                        type="checkbox"
                        checked={
                          problems.length > 0 &&
                          problems.every((name) => selectedProblems[name])
                        }
                        onChange={(event) =>
                          setSelectedProblems((previous) => ({
                            ...previous,
                            ...Object.fromEntries(
                              problems.map((name) => [
                                name,
                                event.target.checked,
                              ]),
                            ),
                          }))
                        }
                        className="w-4 h-4 bg-input-bg border-surface-border-strong rounded text-indigo-500 cursor-pointer"
                        title={t("scoreboard.selectAllProblems")}
                      />
                      <span>{t("scoreboard.total")}</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {contestants.map((contestantName) => {
                  const contestantResult =
                    resultsByContestant.get(contestantName);
                  const totalScore =
                    contestantResult?.problems
                      .filter((problem) =>
                        selectedProblemNames.has(
                          problem.problemName.toLowerCase(),
                        ),
                      )
                      .reduce(
                        (total, problem) => total + problem.summary.score,
                        0,
                      ) || 0;
                  return (
                    <tr
                      key={contestantName}
                      className={`transition ${selectedContestants[contestantName] ? "hover:bg-surface-hover/50" : "opacity-50"}`}
                    >
                      <td className="px-4 py-3 font-mono text-text-primary sticky left-0 bg-surface z-10 border-r border-surface-border">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={!!selectedContestants[contestantName]}
                            onChange={(event) =>
                              setSelectedContestants((previous) => ({
                                ...previous,
                                [contestantName]: event.target.checked,
                              }))
                            }
                            className="w-4 h-4 bg-input-bg border-surface-border-strong rounded text-indigo-500 cursor-pointer"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {contestantName}
                          </span>
                          <button
                            onClick={(event) => {
                              const rect =
                                event.currentTarget.getBoundingClientRect();
                              onOpenActions({
                                type: "contestant",
                                name: contestantName,
                                x: Math.min(
                                  rect.right + 6,
                                  window.innerWidth - 190,
                                ),
                                y: Math.min(rect.top, window.innerHeight - 170),
                              });
                            }}
                            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
                            title={t("scoreboard.actionsFor", {
                              name: contestantName,
                            })}
                          >
                            <EllipsisVertical className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                      {problems.map((problemName) =>
                        renderCell(contestantName, problemName),
                      )}
                      <td className="px-4 py-3 text-center font-bold text-indigo-700 dark:text-indigo-300 border-l border-surface-border bg-total-column sticky right-0 z-10">
                        {contestantResult ? totalScore.toFixed(2) : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}
