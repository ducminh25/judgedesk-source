const MiB = 1024 * 1024;

// JudgeDesk deliberately runs one compile/submission/checker at a time.
// Supports memory limits up to 1,024 MiB (1 GiB) conforming to competitive programming standards.
export const WINDOWS_TOTAL_JUDGING_MEMORY_BUDGET_BYTES = 1024 * MiB;
export const WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES = 1024 * MiB;
export const DEFAULT_COMPILER_MEMORY_LIMIT_BYTES = 1024 * MiB;
export const MAX_SUBMISSION_MEMORY_LIMIT_BYTES = 1024 * MiB;
export const MIN_SUBMISSION_MEMORY_LIMIT_BYTES = 8 * MiB;
export const DEFAULT_SUBMISSION_MEMORY_LIMIT_BYTES = 256 * MiB;

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
