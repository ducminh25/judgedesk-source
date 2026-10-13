import type { BatchJudgeResult, ContestantResult, ProblemResult } from "../../types";
import { addRational, compareRational, createRational, parseRational, rationalToNumber, type Rational } from "../../../shared/rational";
import { hasJudgeError } from "../judging/verdict.js";

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
  return rationalToNumber(selectedTotalScoreRational(contestant, selectedProblems));
}

function selectedTotalScoreRational(
  contestant: ContestantResult | undefined,
  selectedProblems: ReadonlySet<string>,
): Rational {
  let totalRat = createRational(0);
  for (const problem of contestant?.problems ?? []) {
    if (selectedProblems.has(problem.problemName.toLowerCase()) && !hasJudgeError(problem)) {
      totalRat = addRational(totalRat, parseRational(problem.summary.scoreExact ?? problem.summary.score));
    }
  }
  return totalRat;
}

export type ContestantSortMode =
  | "default"
  | "asc"
  | "desc"
  | "score"
  | "score_desc"
  | "score_asc";

export function hasAnyContestantScore(
  result: BatchJudgeResult | null,
  contestantsList: readonly string[],
  problemsList: readonly string[],
  selectedProblems: Readonly<Record<string, boolean>>,
): boolean {
  if (!result || !result.contestants || result.contestants.length === 0) return false;

  const activeProblemsSet = new Set<string>();
  for (const problem of problemsList) {
    if (selectedProblems[problem]) {
      activeProblemsSet.add(problem.toLowerCase());
    }
  }
  const effectiveProblems =
    activeProblemsSet.size > 0
      ? activeProblemsSet
      : new Set(problemsList.map((p) => p.toLowerCase()));

  const resultIndex = indexScoreboardResults(result);
  for (const name of contestantsList) {
    const ct = resultIndex.contestants.get(name);
    if (ct && ct.problems.length > 0) {
      if (effectiveProblems.size === 0) return true;
      if (ct.problems.some((p) => effectiveProblems.has(p.problemName.toLowerCase()))) {
        return true;
      }
    }
  }
  return false;
}

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
  if (sortMode === "score" || sortMode === "score_desc" || sortMode === "score_asc") {
    const resultIndex = indexScoreboardResults(result);
    const activeProblemsSet = new Set<string>();
    for (const problem of problemsList) {
      if (selectedProblems[problem]) {
        activeProblemsSet.add(problem.toLowerCase());
      }
    }
    const effectiveProblems =
      activeProblemsSet.size > 0
        ? activeProblemsSet
        : new Set(problemsList.map((p) => p.toLowerCase()));

    const scoresMap = new Map<string, { hasScore: boolean; score: Rational }>();
    for (const contestant of contestantsList) {
      const ctData = resultIndex.contestants.get(contestant);
      const incomplete = ctData?.problems.some(p => effectiveProblems.has(p.problemName.toLowerCase()) && hasJudgeError(p)) ?? false;
      const hasScore =
        !incomplete &&
        ctData !== undefined &&
        ctData.problems.length > 0 &&
        (effectiveProblems.size === 0 ||
          ctData.problems.some((p) => effectiveProblems.has(p.problemName.toLowerCase())));
      const score = hasScore ? selectedTotalScoreRational(ctData, effectiveProblems) : createRational(0);
      scoresMap.set(contestant, { hasScore, score });
    }

    const isDesc = sortMode === "score" || sortMode === "score_desc";

    return [...contestantsList].sort((a, b) => {
      const entryA = scoresMap.get(a) ?? { hasScore: false, score: createRational(0) };
      const entryB = scoresMap.get(b) ?? { hasScore: false, score: createRational(0) };

      // Contestants without any score are placed at the bottom in both desc and asc modes
      if (entryA.hasScore && !entryB.hasScore) return -1;
      if (!entryA.hasScore && entryB.hasScore) return 1;
      if (!entryA.hasScore && !entryB.hasScore) {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      }

      // Both have scores
      const comparison = compareRational(entryA.score, entryB.score);
      if (comparison !== 0) {
        return isDesc ? -comparison : comparison;
      }

      // Tie-breaker when scores are equal: sort alphabetically A-Z
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    });
  }
  return [...contestantsList];
}

