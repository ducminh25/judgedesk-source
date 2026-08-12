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
