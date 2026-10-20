import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import { ArrowDownWideNarrow, ArrowUpDown, ArrowUpNarrowWide, MoreVertical, Terminal } from "lucide-react";
import type { BatchJudgeResult, ContestantResult, ProblemResult } from "../../types";
import { useTranslation } from "react-i18next";
import {
  type ContestantSortMode,
  indexProblemResults,
  indexScoreboardResults,
  selectedTotalScoreRational,
} from "./scoreboard-model";
import {
  formatRationalDecimal,
  formatScore,
  isTerminatingDecimal,
} from "../../../shared/rational";
import { hasJudgeError } from "../judging/verdict.js";

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
  contestantSort: ContestantSortMode;
  canSortScores?: boolean;
  onToggleScoreSort?: () => void;
  problems: string[];
  result: BatchJudgeResult | null;
  selectedContestants: Record<string, boolean>;
  selectedProblems: Record<string, boolean>;
  interactionLocked: boolean;
  activeContestant?: string | null;
  activeProblem?: string | null;
  onActiveTargetChange?: (contestant: string | null, problem: string | null) => void;
  setContestantSort: Dispatch<SetStateAction<ContestantSortMode>>;
  setSelectedContestants: Dispatch<SetStateAction<Record<string, boolean>>>;
  setSelectedProblems: Dispatch<SetStateAction<Record<string, boolean>>>;
  onOpenActions: (target: ScoreboardActionTarget) => void;
  onOpenDetails: (contestant: string, problem: ProblemResult) => void;
}

const ROW_HEIGHT = 34;

type OpenContextMenu = (
  event: ReactMouseEvent,
  target: Omit<ScoreboardActionTarget, "x" | "y">,
) => void;

function Scoreboard({
  allContestants,
  contestants,
  contestantSort,
  canSortScores = false,
  onToggleScoreSort,
  problems,
  result,
  selectedContestants,
  selectedProblems,
  interactionLocked,
  activeContestant,
  activeProblem,
  onActiveTargetChange,
  setContestantSort,
  setSelectedContestants,
  setSelectedProblems,
  onOpenActions,
  onOpenDetails,
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(1280);

  // Keyboard navigation focus state:
  // focusedRow: -1 (header row) or 0..contestants.length-1
  // focusedCol: -1 (contestant column), 0..problems.length-1 (problem columns), problems.length (total column)
  const [focusedRow, setFocusedRow] = useState<number>(0);
  const [focusedCol, setFocusedCol] = useState<number>(-1);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateSize = () => {
      const width = Math.round(element.clientWidth);
      if (width > 0) {
        setContainerWidth((prev) => (Math.abs(prev - width) >= 2 ? width : prev));
      }
    };
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

  const updateActiveTarget = useCallback((row: number, col: number) => {
    if (!onActiveTargetChange) return;
    const contestant = (row >= 0 && row < contestants.length) ? contestants[row] : null;
    const problem = (col >= 0 && col < problems.length) ? problems[col] : null;
    onActiveTargetChange(contestant, problem);
  }, [contestants, onActiveTargetChange, problems]);

  // Sync external activeContestant / activeProblem when changed from outside
  useEffect(() => {
    if (activeContestant) {
      const rowIndex = contestants.indexOf(activeContestant);
      if (rowIndex >= 0) setFocusedRow(rowIndex);
    }
  }, [activeContestant, contestants]);

  useEffect(() => {
    if (activeProblem) {
      const colIndex = problems.indexOf(activeProblem);
      if (colIndex >= 0) setFocusedCol(colIndex);
    }
  }, [activeProblem, problems]);

  const contestantColumnWidth = Math.max(170, Math.min(260, Math.round(containerWidth * 0.2)));
  const totalColumnWidth = Math.max(86, Math.min(110, Math.round(containerWidth * 0.075)));
  const minimumProblemColumnWidth = 72;
  const availableForProblems = Math.max(0, containerWidth - contestantColumnWidth - totalColumnWidth);
  const estimatedProblemColumnWidth = problems.length > 0 ? availableForProblems / problems.length : 120;
  const problemsFit = problems.length > 0 && estimatedProblemColumnWidth >= minimumProblemColumnWidth;
  const effectiveProblemColumnWidth = Math.max(minimumProblemColumnWidth, estimatedProblemColumnWidth);
  const minTableWidth = contestantColumnWidth + totalColumnWidth + minimumProblemColumnWidth * problems.length;
  const fontSize = effectiveProblemColumnWidth < 88 ? 9 : effectiveProblemColumnWidth < 112 ? 10 : effectiveProblemColumnWidth < 145 ? 11 : 12;
  const headerHeight = effectiveProblemColumnWidth < 120 ? 46 : 38;
  const rowHeight = ROW_HEIGHT;

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

  const handleTableKeyDown = (event: ReactKeyboardEvent) => {
    if (interactionLocked) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedRow((curr) => {
        const next = Math.min(contestants.length - 1, curr + 1);
        updateActiveTarget(next, focusedCol);
        return next;
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedRow((curr) => {
        const next = Math.max(0, curr - 1);
        updateActiveTarget(next, focusedCol);
        return next;
      });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setFocusedCol((curr) => {
        const next = Math.min(problems.length, curr + 1);
        updateActiveTarget(focusedRow, next);
        return next;
      });
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setFocusedCol((curr) => {
        const next = Math.max(-1, curr - 1);
        updateActiveTarget(focusedRow, next);
        return next;
      });
    } else if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      if (focusedRow >= 0 && focusedRow < contestants.length) {
        const contestant = contestants[focusedRow];
        if (focusedCol >= 0 && focusedCol < problems.length) {
          const problem = problems[focusedCol];
          // If on problem column, toggle problem selection or contestant
          setSelectedContestants((prev) => ({ ...prev, [contestant]: !prev[contestant] }));
        } else {
          setSelectedContestants((prev) => ({ ...prev, [contestant]: !prev[contestant] }));
        }
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (focusedRow >= 0 && focusedRow < contestants.length && focusedCol >= 0 && focusedCol < problems.length) {
        const contestant = contestants[focusedRow];
        const problemName = problems[focusedCol];
        const contestantResult = resultIndex.contestants.get(contestant);
        const problem = contestantResult?.problems.find(
          (p) => p.problemName.toLowerCase() === problemName.toLowerCase(),
        );
        if (problem && problem.compileStatus !== "SKIPPED") {
          onOpenDetails(contestant, problem);
        }
      }
    }
  };

  return (
    <main
      ref={containerRef}
      className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto bg-surface select-none outline-none"
        tabIndex={0}
        onKeyDown={handleTableKeyDown}
        onDragStart={(event) => event.preventDefault()}
      >
        {allContestants.length === 0 && problems.length === 0 ? (
          <div className="flex h-full min-h-80 w-full flex-col items-center justify-center text-center text-text-muted">
            <Terminal className="mb-3 h-8 w-8 text-surface-border-strong" />
            <p className="max-w-sm text-xs">{t("scoreboard.noContestants")}</p>
          </div>
        ) : (
          <table
            ref={tableRef}
            className="relative border-collapse text-left w-full"
            style={{ minWidth: minTableWidth, tableLayout: "fixed", fontSize }}
          >
            <colgroup>
              <col style={{ width: contestantColumnWidth }} />
              {problems.map((problemName) => (
                <col
                  key={problemName}
                  style={problemsFit ? undefined : { width: minimumProblemColumnWidth }}
                />
              ))}
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
                      className={`flex h-6 w-6 flex-none items-center justify-center rounded hover:bg-surface-hover ${contestantSort === "asc" || contestantSort === "desc" ? "text-indigo-500" : "text-text-muted"}`}
                      title={t("scoreboard.sortAlphabetically")}
                      aria-label={t("scoreboard.sortAlphabetically")}
                    >
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </th>
                {problems.map((problemName, colIdx) => {
                  const hasResults = resultIndex.problemsWithResults.has(problemName.toLowerCase());
                  const isColFocused = focusedCol === colIdx;
                  return (
                    <th
                      key={problemName}
                      onClick={() => {
                        setFocusedCol(colIdx);
                        updateActiveTarget(focusedRow, colIdx);
                      }}
                      onContextMenu={(event) => openContextMenu(event, {
                        type: "problem",
                        name: problemName,
                        problemName,
                        hasResults,
                        canRegrade: contestants.length > 0,
                      })}
                      className={`border-b border-l border-surface-border bg-surface-elevated px-1.5 text-center font-semibold text-text-primary hover:bg-surface-hover ${isColFocused ? "bg-indigo-50/50 dark:bg-indigo-950/30" : ""}`}
                    >
                      <div className="flex items-center justify-center gap-1.5 py-1">
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
                    {onToggleScoreSort && (
                      <button
                        type="button"
                        disabled={interactionLocked || !canSortScores}
                        onClick={onToggleScoreSort}
                        className={`flex h-6 w-6 flex-none items-center justify-center rounded hover:bg-surface-hover ${
                          contestantSort === "score" ||
                          contestantSort === "score_desc" ||
                          contestantSort === "score_asc"
                            ? "text-indigo-500"
                            : "text-text-muted"
                        } disabled:cursor-not-allowed disabled:opacity-40`}
                        title={
                          !canSortScores
                            ? t("scoreboard.sortScoreDisabledHint", "Cần có ít nhất 1 điểm để sắp xếp")
                            : contestantSort === "score" || contestantSort === "score_desc"
                              ? t("scoreboard.sortScoreDescHint", "Đang xếp: Điểm cao → thấp. Bấm để xếp: Điểm thấp → cao")
                              : contestantSort === "score_asc"
                                ? t("scoreboard.sortScoreAscHint", "Đang xếp: Điểm thấp → cao. Bấm để về ban đầu (A-Z)")
                                : t("scoreboard.sortScoreDefaultHint", "Sắp xếp: Điểm cao xuống thấp")
                        }
                        aria-label={t("scoreboard.sortScores", "Sắp xếp điểm")}
                      >
                        {contestantSort === "score" || contestantSort === "score_desc" ? (
                          <ArrowDownWideNarrow className="h-3.5 w-3.5" />
                        ) : contestantSort === "score_asc" ? (
                          <ArrowUpNarrowWide className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {contestants.map((contestantName, rowIdx) => (
                <ScoreboardRow
                  key={contestantName}
                  rowIndex={rowIdx}
                  focusedRow={focusedRow}
                  focusedCol={focusedCol}
                  contestantName={contestantName}
                  contestantResult={resultIndex.contestants.get(contestantName)}
                  selected={!!selectedContestants[contestantName]}
                  selectedProblemNames={selectedProblemNames}
                  problems={problems}
                  interactionLocked={interactionLocked}
                  rowHeight={rowHeight}
                  onSelectCell={(r, c) => {
                    setFocusedRow(r);
                    setFocusedCol(c);
                    updateActiveTarget(r, c);
                  }}
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
  rowIndex: number;
  focusedRow: number;
  focusedCol: number;
  contestantName: string;
  contestantResult: ContestantResult | undefined;
  selected: boolean;
  selectedProblemNames: ReadonlySet<string>;
  problems: string[];
  interactionLocked: boolean;
  rowHeight: number;
  onSelectCell: (row: number, col: number) => void;
  setSelectedContestants: Dispatch<SetStateAction<Record<string, boolean>>>;
  openContextMenu: OpenContextMenu;
  onOpenDetails: (contestant: string, problem: ProblemResult) => void;
}

const ScoreboardRow = memo(function ScoreboardRow({
  rowIndex,
  focusedRow,
  focusedCol,
  contestantName,
  contestantResult,
  selected,
  selectedProblemNames,
  problems,
  interactionLocked,
  rowHeight,
  onSelectCell,
  setSelectedContestants,
  openContextMenu,
  onOpenDetails,
}: ScoreboardRowProps) {
  const { t } = useTranslation();
  const problemResults = useMemo(
    () => indexProblemResults(contestantResult),
    [contestantResult],
  );
  const totalScoreText = useMemo(() => {
    const totalRat = selectedTotalScoreRational(contestantResult, selectedProblemNames);
    return isTerminatingDecimal(totalRat.d)
      ? formatScore(totalRat, 4)
      : formatRationalDecimal(totalRat, 2);
  }, [contestantResult, selectedProblemNames]);
  const incompleteTotal = contestantResult?.problems.some(problem =>
    selectedProblemNames.has(problem.problemName.toLowerCase()) && hasJudgeError(problem)) ?? false;
  const contestantTarget = {
    type: "contestant" as const,
    name: contestantName,
    contestantName,
    hasResults: problemResults.size > 0,
    canRegrade: problems.length > 0,
  };

  const isRowFocused = focusedRow === rowIndex;

  return (
    <tr
      style={{ height: rowHeight }}
      className={`${selected ? "hover:bg-surface-hover/40" : "opacity-50"} ${isRowFocused ? "bg-indigo-50/30 dark:bg-indigo-950/20" : ""}`}
    >
      <td
        onClick={() => onSelectCell(rowIndex, -1)}
        onContextMenu={(event) => openContextMenu(event, contestantTarget)}
        className={`sticky left-0 z-10 cursor-default border-b border-r border-surface-border bg-surface px-2 font-mono text-text-primary ${isRowFocused && focusedCol === -1 ? "ring-2 ring-indigo-500 ring-inset" : ""}`}
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
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={contestantName}>{contestantName}</span>
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
      {problems.map((problemName, colIdx) => {
        const problem = problemResults.get(problemName.toLowerCase());
        const isCellFocused = isRowFocused && focusedCol === colIdx;
        let displayText: string | number = "-";
        let colorClass = "text-text-muted";
        if (problem) {
          displayText = formatScore(problem.summary.scoreExact ?? problem.summary.score);
          if (problem.compileStatus === "SKIPPED" && problem.compileError === "not_found") {
            displayText = t("scoreboard.notFound");
            colorClass = "text-text-muted bg-surface-hover";
          } else if (hasJudgeError(problem)) {
            displayText = "JE";
            colorClass = "bg-amber-100 font-bold text-amber-700 dark:bg-amber-950/25 dark:text-amber-400";
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
            onClick={() => onSelectCell(rowIndex, colIdx)}
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
            className={`border-b border-l border-surface-border px-2 text-center align-middle transition-[filter] hover:brightness-95 dark:hover:brightness-110 ${problem ? "cursor-pointer" : "cursor-default"} ${colorClass} ${isCellFocused ? "ring-2 ring-indigo-500 ring-inset" : ""}`}
            style={{ height: rowHeight }}
            title={problem ? hasJudgeError(problem) ? t("judgingDetails.judgeErrorHelp") : t("scoreboard.resultStatus", {
              status: problem.summary.status,
              compileStatus: problem.compileStatus,
            }) : undefined}
          >
            <span className="block whitespace-nowrap font-mono tabular-nums">{displayText}</span>
          </td>
        );
      })}
      <td
        onClick={() => onSelectCell(rowIndex, problems.length)}
        onContextMenu={(event) => openContextMenu(event, contestantTarget)}
        className={`sticky right-0 z-10 cursor-default border-b border-l border-surface-border bg-total-column px-2 text-center font-mono font-bold tabular-nums text-indigo-700 dark:text-indigo-300 ${isRowFocused && focusedCol === problems.length ? "ring-2 ring-indigo-500 ring-inset" : ""}`}
        style={{ height: rowHeight }}
        title={incompleteTotal ? t("judgingDetails.judgeErrorHelp") : undefined}
      >
        <span className="block whitespace-nowrap font-mono tabular-nums">{incompleteTotal ? "JE" : contestantResult ? totalScoreText : "-"}</span>
      </td>
    </tr>
  );
});

export default memo(Scoreboard);
