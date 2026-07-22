export function hasSavableContestData(
  contestantCount: number,
  problemCount: number,
): boolean {
  return contestantCount > 0 || problemCount > 0;
}

export function shouldPromptForUnsavedContest(
  dirty: boolean,
  contestantCount: number,
  problemCount: number,
): boolean {
  return dirty && hasSavableContestData(contestantCount, problemCount);
}
