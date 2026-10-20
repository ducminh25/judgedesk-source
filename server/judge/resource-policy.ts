const MiB = 1024 * 1024;

// JudgeDesk deliberately runs one compile/submission/checker at a time.
// Supports memory limits up to 1,024 MiB (1 GiB) conforming to competitive programming standards.
// Per C03 resource envelope contract:
// - Representative S256/S512 workloads (memoryLimit <= 512 MiB) stay below 1,024 MiB total tree peak
//   for both private committed memory (PrivateMemorySize64) and un-deduplicated working set (WorkingSet64).
// - Maximum SMAX/CMAX workloads (512 MiB < memoryLimit <= 1,024 MiB) are bounded by:
//   * <= 1,408 MiB combined peak private committed memory (1,024 MiB Job Object commit quota + 384 MiB B384 app/host private budget)
//   * <= 1,792 MiB combined peak un-deduplicated multi-process working set (1,024 MiB active run working set + 768 MiB multi-process host working-set ceiling).
export const WINDOWS_TOTAL_JUDGING_MEMORY_BUDGET_BYTES = 1024 * MiB;
export const WINDOWS_REPRESENTATIVE_SUBMISSION_MEMORY_CAP_BYTES = 512 * MiB;
export const WINDOWS_APP_HOST_MEMORY_BUDGET_BYTES = 384 * MiB;
export const WINDOWS_APP_HOST_WORKING_SET_CEILING_BYTES = 768 * MiB;
export const WINDOWS_REPRESENTATIVE_TOTAL_MEMORY_BUDGET_BYTES = 1024 * MiB;
export const WINDOWS_MAX_TOTAL_JUDGING_MEMORY_BUDGET_BYTES =
  WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES_VALUE() + WINDOWS_APP_HOST_MEMORY_BUDGET_BYTES;
export const WINDOWS_MAX_TOTAL_WORKING_SET_BUDGET_BYTES =
  WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES_VALUE() + WINDOWS_APP_HOST_WORKING_SET_CEILING_BYTES;
export const WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES = 1024 * MiB;
export const DEFAULT_COMPILER_MEMORY_LIMIT_BYTES = 1024 * MiB;
export const MAX_SUBMISSION_MEMORY_LIMIT_BYTES = 1024 * MiB;
export const MIN_SUBMISSION_MEMORY_LIMIT_BYTES = 8 * MiB;
export const DEFAULT_SUBMISSION_MEMORY_LIMIT_BYTES = 256 * MiB;

function WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES_VALUE(): number {
  return 1024 * MiB;
}

export type WindowsJudgingWorkloadProfile = "S256_S512" | "SMAX";

export interface WindowsTotalJudgingMemoryBudget {
  profile: WindowsJudgingWorkloadProfile;
  configuredSubmissionMemoryLimitBytes: number;
  appHostBudgetBytes: number;
  appHostWorkingSetCeilingBytes: number;
  totalBudgetBytes: number;
  totalWorkingSetBudgetBytes: number;
}

export function resolveWindowsTotalJudgingMemoryBudgetBytes(
  configuredMemoryMb?: number,
): WindowsTotalJudgingMemoryBudget {
  const configuredSubmissionMemoryLimitBytes =
    resolveConfiguredSubmissionMemoryLimitBytes(configuredMemoryMb);
  const profile: WindowsJudgingWorkloadProfile =
    configuredSubmissionMemoryLimitBytes <= WINDOWS_REPRESENTATIVE_SUBMISSION_MEMORY_CAP_BYTES
      ? "S256_S512"
      : "SMAX";
  return {
    profile,
    configuredSubmissionMemoryLimitBytes,
    appHostBudgetBytes: WINDOWS_APP_HOST_MEMORY_BUDGET_BYTES,
    appHostWorkingSetCeilingBytes: WINDOWS_APP_HOST_WORKING_SET_CEILING_BYTES,
    totalBudgetBytes:
      profile === "S256_S512"
        ? WINDOWS_REPRESENTATIVE_TOTAL_MEMORY_BUDGET_BYTES
        : WINDOWS_MAX_TOTAL_JUDGING_MEMORY_BUDGET_BYTES,
    totalWorkingSetBudgetBytes:
      profile === "S256_S512"
        ? WINDOWS_REPRESENTATIVE_TOTAL_MEMORY_BUDGET_BYTES
        : WINDOWS_MAX_TOTAL_WORKING_SET_BUDGET_BYTES,
  };
}

export function resolveCompilerMemoryLimitBytes(
  platform: NodeJS.Platform = process.platform,
): number {
  return DEFAULT_COMPILER_MEMORY_LIMIT_BYTES;
}

export function resolveSubmissionMemoryLimitBytes(
  configuredMemoryMb: number | undefined,
  platform: NodeJS.Platform = process.platform,
): number {
  const requestedBytes = resolveConfiguredSubmissionMemoryLimitBytes(configuredMemoryMb);
  return Math.min(requestedBytes, MAX_SUBMISSION_MEMORY_LIMIT_BYTES);
}

export function resolveConfiguredSubmissionMemoryLimitBytes(
  configuredMemoryMb: number | undefined,
): number {
  const parsed = Number(configuredMemoryMb);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SUBMISSION_MEMORY_LIMIT_BYTES;
  }
  return Math.min(
    MAX_SUBMISSION_MEMORY_LIMIT_BYTES,
    Math.max(MIN_SUBMISSION_MEMORY_LIMIT_BYTES, Math.round(parsed) * MiB),
  );
}

export class SingleJudgeSessionGate {
  private active = false;

  tryAcquire(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  release(): void {
    this.active = false;
  }
}

export const sharedJudgeSessionGate = new SingleJudgeSessionGate();
