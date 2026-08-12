import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import { ArrowUpDown, MoreVertical, Terminal } from "lucide-react";
import type { BatchJudgeResult, ContestantResult, ProblemResult } from "../../types";
import { useTranslation } from "react-i18next";
import {
  indexProblemResults,
  indexScoreboardResults,
  selectedTotalScore,
} from "./scoreboard-model";

export interface ScoreboardActionTarget {
  type: "problem" | "contestant" | "result";
  name: string;
  contestantName?: string;
  problemName?: string;
  x: number;
  y: number;
  hasResults: boolean;
  canRegrade: boolean;
}

interface Props {
  allContestants: string[];
  contestants: string[];
  contestantSort: "default" | "asc" | "desc" | "score";
  problems: string[];
  result: BatchJudgeResult | null;
  selectedContestants: Record<string, boolean>;
  selectedProblems: Record<string, boolean>;
  interactionLocked: boolean;
  setContestantSort: Dispatch<SetStateAction<"default" | "asc" | "desc" | "score">>;
  setSelectedContestants: Dispatch<SetStateAction<Record<string, boolean>>>;
  setSelectedProblems: Dispatch<SetStateAction<Record<string, boolean>>>;
  onOpenActions: (target: ScoreboardActionTarget) => void;
  onOpenDetails: (contestant: string, problem: ProblemResult) => void;
}

interface ViewportSize {
  width: number;
  height: number;
}

type OpenContextMenu = (
  event: ReactMouseEvent,
  target: Omit<ScoreboardActionTarget, "x" | "y">,
) => void;

function Scoreboard({
  allContestants,
  contestants,
  contestantSort,
  problems,
  result,
  selectedContestants,
  selectedProblems,
  interactionLocked,
  setContestantSort,
  setSelectedContestants,
  setSelectedProblems,
  onOpenActions,
  onOpenDetails,
}: Props) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<ViewportSize>({ width: 1280, height: 700 });

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateSize = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const resultIndex = useMemo(() => indexScoreboardResults(result), [result]);
  const selectedProblemNames = useMemo(
    () => new Set(Object.keys(selectedProblems).filter((problem) => selectedProblems[problem]).map((name) => name.toLowerCase())),
    [selectedProblems],
  );

  const contestantColumnWidth = Math.max(170, Math.min(260, Math.round(viewport.width * 0.2)));
  const totalColumnWidth = Math.max(86, Math.min(110, Math.round(viewport.width * 0.075)));
  const minimumProblemColumnWidth = 72;
  const fittedProblemColumnWidth = problems.length > 0
    ? (viewport.width - contestantColumnWidth - totalColumnWidth) / problems.length
    : 0;
  const problemColumnWidth = Math.max(minimumProblemColumnWidth, fittedProblemColumnWidth);
  const tableWidth = Math.max(
    viewport.width,
    contestantColumnWidth + totalColumnWidth + problemColumnWidth * problems.length,
  );
  const fontSize = problemColumnWidth < 88 ? 9 : problemColumnWidth < 112 ? 10 : problemColumnWidth < 145 ? 11 : 12;
  const headerHeight = problemColumnWidth < 120 ? 46 : 38;
  const rowHeight = contestants.length > 0
    ? Math.max(24, Math.min(38, Math.floor((viewport.height - headerHeight) / contestants.length)))
    : 32;

  const openContextMenu = useCallback((
    event: ReactMouseEvent,
    target: Omit<ScoreboardActionTarget, "x" | "y">,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const requestedX = event.clientX || rect.left + 12;
    const requestedY = event.clientY || rect.bottom + 4;
    onOpenActions({
      ...target,
      x: Math.max(4, Math.min(requestedX, window.innerWidth - 224)),
      y: Math.max(4, Math.min(requestedY, window.innerHeight - 196)),
    });
  }, [onOpenActions]);

  return (
    <main
      className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto bg-surface select-none"
        onDragStart={(event) => event.preventDefault()}
      >
        {allContestants.length === 0 && problems.length === 0 ? (
          <div className="flex h-full min-h-80 w-full flex-col items-center justify-center text-center text-text-muted">
            <Terminal className="mb-3 h-8 w-8 text-surface-border-strong" />
            <p className="max-w-sm text-xs">{t("scoreboard.noContestants")}</p>
          </div>
        ) : (
          <table
            className="relative border-collapse text-left"
            style={{ width: tableWidth, tableLayout: "fixed", fontSize }}
          >
            <colgroup>
              <col style={{ width: contestantColumnWidth }} />
              {problems.map((problemName) => <col key={problemName} style={{ width: problemColumnWidth }} />)}
              <col style={{ width: totalColumnWidth }} />
            </colgroup>
            <thead className="sticky top-0 z-20 bg-surface-elevated shadow-sm">
              <tr style={{ height: headerHeight }}>
                <th className="sticky left-0 z-30 border-b border-r border-surface-border bg-surface-elevated px-2 font-semibold text-text-primary">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={interactionLocked}
                        checked={allContestants.length > 0 && allContestants.every((name) => selectedContestants[name])}
                        onChange={(event) => setSelectedContestants((previous) => ({
                          ...previous,
                          ...Object.fromEntries(allContestants.map((name) => [name, event.target.checked])),
                        }))}
                        className="h-4 w-4 flex-none cursor-pointer rounded border-surface-border-strong bg-input-bg text-indigo-500"
                        title={t("scoreboard.selectAllContestants")}
                      />
                      <span className="whitespace-nowrap">{t("scoreboard.contestants")}</span>
                    </div>
                    <button
                      type="button"
                      disabled={interactionLocked}
                      onClick={() => setContestantSort((previous) => previous === "default" ? "asc" : previous === "asc" ? "desc" : "default")}
                      className={`flex h-6 w-6 flex-none items-center justify-center rounded hover:bg-surface-hover ${contestantSort !== "default" && contestantSort !== "score" ? "text-indigo-500" : "text-text-muted"}`}
                      title={t("scoreboard.sortAlphabetically")}
                    >
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </th>
                {problems.map((problemName) => {
                  const hasResults = resultIndex.problemsWithResults.has(problemName.toLowerCase());
                  return (
                    <th
                      key={problemName}
                      onContextMenu={(event) => openContextMenu(event, {
                        type: "problem",
                        name: problemName,
                        problemName,
                        hasResults,
                        canRegrade: contestants.length > 0,
                      })}
                      className="border-b border-l border-surface-border bg-surface-elevated px-1.5 text-center font-semibold text-text-primary hover:bg-surface-hover"
                    >
                      <div className="flex min-w-0 items-center justify-center gap-1">
                        <input
                          type="checkbox"
                          disabled={interactionLocked}
                          checked={!!selectedProblems[problemName]}
                          onChange={(event) => setSelectedProblems((previous) => ({ ...previous, [problemName]: event.target.checked }))}
                          className="h-4 w-4 flex-none cursor-pointer rounded border-surface-border-strong bg-input-bg text-indigo-500"
                          title={t("scoreboard.selectProblem")}
                        />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere] leading-tight">{problemName}</span>
                        <button
                          type="button"
                          onClick={(event) => openContextMenu(event, {
                            type: "problem",
                            name: problemName,
                            problemName,
                            hasResults,
                            canRegrade: contestants.length > 0,
                          })}
                          className="flex h-6 w-5 flex-none items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
                          title={t("scoreboard.actionsFor", { name: problemName })}
                          aria-label={t("scoreboard.actionsFor", { name: problemName })}
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </th>
                  );
                })}
                <th className="sticky right-0 z-30 border-b border-l border-surface-border bg-total-column px-2 text-center font-semibold text-indigo-700 dark:text-indigo-300">
                  <div className="flex items-center justify-center gap-2">
                    <input
                      type="checkbox"
                      disabled={interactionLocked}
                      checked={problems.length > 0 && problems.every((name) => selectedProblems[name])}
                      onChange={(event) => setSelectedProblems((previous) => ({
                        ...previous,
                        ...Object.fromEntries(problems.map((name) => [name, event.target.checked])),
                      }))}
                      className="h-4 w-4 flex-none cursor-pointer rounded border-surface-border-strong bg-input-bg text-indigo-500"
                      title={t("scoreboard.selectAllProblems")}
                    />
                    <span>{t("scoreboard.total")}</span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {contestants.map((contestantName) => (
                <ScoreboardRow
                  key={contestantName}
                  contestantName={contestantName}
                  contestantResult={resultIndex.contestants.get(contestantName)}
                  selected={!!selectedContestants[contestantName]}
                  selectedProblemNames={selectedProblemNames}
                  problems={problems}
                  interactionLocked={interactionLocked}
                  rowHeight={rowHeight}
                  setSelectedContestants={setSelectedContestants}
                  openContextMenu={openContextMenu}
                  onOpenDetails={onOpenDetails}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

interface ScoreboardRowProps {
  contestantName: string;
  contestantResult: ContestantResult | undefined;
  selected: boolean;
  selectedProblemNames: ReadonlySet<string>;
  problems: string[];
  interactionLocked: boolean;
  rowHeight: number;
  setSelectedContestants: Dispatch<SetStateAction<Record<string, boolean>>>;
  openContextMenu: OpenContextMenu;
  onOpenDetails: (contestant: string, problem: ProblemResult) => void;
}

const ScoreboardRow = memo(function ScoreboardRow({
  contestantName,
  contestantResult,
  selected,
  selectedProblemNames,
  problems,
  interactionLocked,
  rowHeight,
  setSelectedContestants,
  openContextMenu,
  onOpenDetails,
}: ScoreboardRowProps) {
  const { t } = useTranslation();
  const problemResults = useMemo(
    () => indexProblemResults(contestantResult),
    [contestantResult],
  );
  const totalScore = useMemo(
    () => selectedTotalScore(contestantResult, selectedProblemNames),
    [contestantResult, selectedProblemNames],
  );
  const contestantTarget = {
    type: "contestant" as const,
    name: contestantName,
    contestantName,
    hasResults: problemResults.size > 0,
    canRegrade: problems.length > 0,
  };

  return (
    <tr className={selected ? "hover:bg-surface-hover/40" : "opacity-50"}>
      <td
        onContextMenu={(event) => openContextMenu(event, contestantTarget)}
        className="sticky left-0 z-10 cursor-default border-b border-r border-surface-border bg-surface px-2 font-mono text-text-primary"
        style={{ height: rowHeight }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <input
            type="checkbox"
            disabled={interactionLocked}
            checked={selected}
            onChange={(event) => setSelectedContestants((previous) => ({
              ...previous,
              [contestantName]: event.target.checked,
            }))}
            className="h-4 w-4 flex-none cursor-pointer rounded border-surface-border-strong bg-input-bg text-indigo-500"
          />
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] leading-tight">{contestantName}</span>
          <button
            type="button"
            onClick={(event) => openContextMenu(event, contestantTarget)}
            className="flex h-6 w-5 flex-none items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
            title={t("scoreboard.actionsFor", { name: contestantName })}
            aria-label={t("scoreboard.actionsFor", { name: contestantName })}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
      {problems.map((problemName) => {
        const problem = problemResults.get(problemName.toLowerCase());
        let displayText: string | number = "-";
        let colorClass = "text-text-muted";
        if (problem) {
          displayText = problem.summary.score;
          if (problem.compileStatus === "SKIPPED" && problem.compileError === "not_found") {
            displayText = t("scoreboard.notFound");
            colorClass = "text-text-muted bg-surface-hover";
          } else if (problem.compileStatus === "CE") {
            displayText = "CE";
            colorClass = "bg-rose-100 font-bold text-rose-700 dark:bg-rose-950/30 dark:text-rose-400";
          } else if (problem.summary.status === "AC") {
            colorClass = "bg-emerald-100 font-bold text-emerald-700 dark:bg-emerald-950/25 dark:text-emerald-400";
          } else if (problem.summary.status === "PARTIAL") {
            colorClass = "bg-amber-100 font-bold text-amber-700 dark:bg-amber-950/25 dark:text-amber-400";
          } else {
            colorClass = "bg-rose-50 text-rose-700 dark:bg-rose-950/15 dark:text-rose-400";
          }
        }
        return (
          <td
            key={problemName}
            onContextMenu={(event) => openContextMenu(event, {
              type: "result",
              name: `${contestantName} · ${problemName}`,
              contestantName,
              problemName,
              hasResults: !!problem,
              canRegrade: true,
            })}
            onDoubleClick={() => {
              if (problem && problem.compileStatus !== "SKIPPED") {
                onOpenDetails(contestantName, problem);
              }
            }}
            className={`border-b border-l border-surface-border px-2 text-center align-middle transition-[filter] hover:brightness-95 dark:hover:brightness-110 ${problem ? "cursor-pointer" : "cursor-default"} ${colorClass}`}
            style={{ height: rowHeight }}
            title={problem ? t("scoreboard.resultStatus", {
              status: problem.summary.status,
              compileStatus: problem.compileStatus,
            }) : undefined}
          >
            <span className="block whitespace-nowrap">{displayText}</span>
          </td>
        );
      })}
      <td
        onContextMenu={(event) => openContextMenu(event, contestantTarget)}
        className="sticky right-0 z-10 cursor-default border-b border-l border-surface-border bg-total-column px-2 text-center font-bold text-indigo-700 dark:text-indigo-300"
        style={{ height: rowHeight }}
      >
        {contestantResult ? totalScore.toFixed(2) : "-"}
      </td>
    </tr>
  );
});

export default memo(Scoreboard);
