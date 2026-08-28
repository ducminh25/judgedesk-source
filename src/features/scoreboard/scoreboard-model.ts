import type { BatchJudgeResult, ContestantResult, ProblemResult } from "../../types";

export interface ScoreboardResultIndex {
  contestants: ReadonlyMap<string, ContestantResult>;
  problemsWithResults: ReadonlySet<string>;
}

export function indexScoreboardResults(result: BatchJudgeResult | null): ScoreboardResultIndex {
  const contestants = new Map<string, ContestantResult>();
  const problemsWithResults = new Set<string>();
  for (const contestant of result?.contestants ?? []) {
    contestants.set(contestant.contestantName, contestant);
    for (const problem of contestant.problems) {
      problemsWithResults.add(problem.problemName.toLowerCase());
    }
  }
  return { contestants, problemsWithResults };
}

export function indexProblemResults(
  contestant: ContestantResult | undefined,
): ReadonlyMap<string, ProblemResult> {
  const problems = new Map<string, ProblemResult>();
  for (const problem of contestant?.problems ?? []) {
    const normalizedName = problem.problemName.toLowerCase();
    if (!problems.has(normalizedName)) problems.set(normalizedName, problem);
  }
  return problems;
}

export function selectedTotalScore(
  contestant: ContestantResult | undefined,
  selectedProblems: ReadonlySet<string>,
): number {
  let total = 0;
  for (const problem of contestant?.problems ?? []) {
    if (selectedProblems.has(problem.problemName.toLowerCase())) {
      total += problem.summary.score;
    }
  }
  return total;
}

export type ContestantSortMode = "default" | "asc" | "desc" | "score";

export function sortContestants(
  contestantsList: readonly string[],
  sortMode: ContestantSortMode,
  result: BatchJudgeResult | null,
  problemsList: readonly string[],
  selectedProblems: Readonly<Record<string, boolean>>,
): string[] {
  if (sortMode === "asc") {
    return [...contestantsList].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
  }
  if (sortMode === "desc") {
    return [...contestantsList].sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
    );
  }
  if (sortMode === "score") {
    const resultIndex = indexScoreboardResults(result);
    const activeProblemsSet = new Set<string>();
    for (const problem of problemsList) {
      if (selectedProblems[problem]) {
        activeProblemsSet.add(problem.toLowerCase());
      }
    }
    const scoresMap = new Map<string, number>();
    for (const contestant of contestantsList) {
      const ctData = resultIndex.contestants.get(contestant);
      scoresMap.set(contestant, selectedTotalScore(ctData, activeProblemsSet));
    }
    return [...contestantsList].sort(
      (a, b) => (scoresMap.get(b) ?? 0) - (scoresMap.get(a) ?? 0),
    );
  }
  return [...contestantsList];
}

