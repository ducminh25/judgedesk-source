import type { BatchJudgeResult, ProblemResult } from "../../types";

export type JudgeResultsAction =
  | { type: "initialize" }
  | { type: "replace"; result: BatchJudgeResult | null }
  | { type: "merge_problem"; contestant: string; problemResult: ProblemResult }
  | { type: "delete_result"; contestantName: string; problemName: string }
  | { type: "delete_selected"; contestantNames: string[]; problemNames: string[] }
  | { type: "delete_problem"; problemName: string }
  | { type: "delete_contestant"; contestantName: string };

export function judgeResultsReducer(
  state: BatchJudgeResult | null,
  action: JudgeResultsAction
): BatchJudgeResult | null {
  if (action.type === "initialize") {
    return state ?? { success: true, contestants: [] };
  }
  if (action.type === "replace") {
    return action.result;
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
  if (action.type === "delete_result") {
    return state
      ? {
          ...state,
          contestants: state.contestants
            .map((contestant) =>
              contestant.contestantName === action.contestantName
                ? {
                    ...contestant,
                    problems: contestant.problems.filter(
                      (problem) =>
                        problem.problemName.toLowerCase() !== action.problemName.toLowerCase(),
                    ),
                  }
                : contestant,
            )
            .filter((contestant) => contestant.problems.length > 0),
        }
      : state;
  }
  if (action.type === "delete_selected") {
    if (!state) return state;
    const contestants = new Set(action.contestantNames);
    const problems = new Set(action.problemNames.map((name) => name.toLowerCase()));
    return {
      ...state,
      contestants: state.contestants
        .map((contestant) => contestants.has(contestant.contestantName)
          ? {
              ...contestant,
              problems: contestant.problems.filter(
                (problem) => !problems.has(problem.problemName.toLowerCase()),
              ),
            }
          : contestant)
        .filter((contestant) => contestant.problems.length > 0),
    };
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
