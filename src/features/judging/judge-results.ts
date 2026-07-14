import type { BatchJudgeResult, ProblemResult } from "../../types";

export type JudgeResultsAction =
  | { type: "initialize" }
  | { type: "merge_problem"; contestant: string; problemResult: ProblemResult }
  | { type: "delete_problem"; problemName: string }
  | { type: "delete_contestant"; contestantName: string };

export function judgeResultsReducer(
  state: BatchJudgeResult | null,
  action: JudgeResultsAction
): BatchJudgeResult | null {
  if (action.type === "initialize") {
    return state ?? { success: true, contestants: [] };
  }
  if (action.type === "merge_problem") {
    return mergeProblemResult(state, action.contestant, action.problemResult);
  }
  if (action.type === "delete_problem") {
    return state
      ? {
          ...state,
          contestants: state.contestants.map((contestant) => ({
            ...contestant,
            problems: contestant.problems.filter(
              (problem) => problem.problemName.toLowerCase() !== action.problemName.toLowerCase()
            )
          }))
        }
      : state;
  }
  return state
    ? {
        ...state,
        contestants: state.contestants.filter(
          (contestant) => contestant.contestantName !== action.contestantName
        )
      }
    : state;
}

function mergeProblemResult(
  state: BatchJudgeResult | null,
  contestantName: string,
  problemResult: ProblemResult
): BatchJudgeResult {
  const current = state ?? { success: true, contestants: [] };
  const contestantIndex = current.contestants.findIndex(
    (contestant) => contestant.contestantName === contestantName
  );

  if (contestantIndex < 0) {
    return {
      ...current,
      contestants: [
        ...current.contestants,
        { contestantName, problems: [problemResult] }
      ]
    };
  }

  const existingContestant = current.contestants[contestantIndex];
  const problemIndex = existingContestant.problems.findIndex(
    (problem) => problem.problemName.toLowerCase() === problemResult.problemName.toLowerCase()
  );
  const problems =
    problemIndex < 0
      ? [...existingContestant.problems, problemResult]
      : existingContestant.problems.map((problem, index) =>
          index === problemIndex ? problemResult : problem
        );

  return {
    ...current,
    contestants: current.contestants.map((contestant, index) =>
      index === contestantIndex ? { ...existingContestant, problems } : contestant
    )
  };
}
