export function selectedNames(
  names: readonly string[],
  selection: Readonly<Record<string, boolean>>,
): string[] {
  return names.filter((name) => selection[name] === true);
}

export interface JudgeAvailability {
  contestantsPath: string;
  testsPath: string;
  contestantNames: readonly string[];
  problemNames: readonly string[];
  secureRunnerReady: boolean;
}

export function canStartJudge(availability: JudgeAvailability): boolean {
  return availability.contestantsPath.trim().length > 0
    && availability.testsPath.trim().length > 0
    && availability.contestantNames.length > 0
    && availability.problemNames.length > 0
    && availability.secureRunnerReady;
}

export function canExportScoreboard(
  contestantNames: readonly string[],
  problemNames: readonly string[],
): boolean {
  return contestantNames.length > 0 || problemNames.length > 0;
}

export type JudgeDisabledReason =
  | "runnerUnavailable"
  | "missingData"
  | "noSelection";

export function getJudgeDisabledReason(
  availability: JudgeAvailability,
): JudgeDisabledReason | null {
  if (!availability.secureRunnerReady) {
    return "runnerUnavailable";
  }
  if (!availability.contestantsPath.trim() || !availability.testsPath.trim()) {
    return "missingData";
  }
  if (availability.contestantNames.length === 0 || availability.problemNames.length === 0) {
    return "noSelection";
  }
  return null;
}

