const MiB = 1024 * 1024;

// JudgeDesk deliberately runs one compile/submission/checker at a time. Keeping
// the active child below half of the Windows-wide budget leaves room for the
// Tauri/WebView UI, backend, executor and operating-system runtime libraries.
export const WINDOWS_TOTAL_JUDGING_MEMORY_BUDGET_BYTES = 1024 * MiB;
export const WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES = 512 * MiB;
export const DEFAULT_COMPILER_MEMORY_LIMIT_BYTES = 1024 * MiB;

export function resolveCompilerMemoryLimitBytes(
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32"
    ? WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES
    : DEFAULT_COMPILER_MEMORY_LIMIT_BYTES;
}

export function resolveSubmissionMemoryLimitBytes(
  configuredMemoryMb: number | undefined,
  platform: NodeJS.Platform = process.platform,
): number {
  const requestedBytes = resolveConfiguredSubmissionMemoryLimitBytes(configuredMemoryMb);
  return platform === "win32"
    ? Math.min(requestedBytes, WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES)
    : requestedBytes;
}

export function resolveConfiguredSubmissionMemoryLimitBytes(
  configuredMemoryMb: number | undefined,
): number {
  const parsed = Number(configuredMemoryMb);
  return Math.max(
    8 * MiB,
    (Number.isFinite(parsed) && parsed > 0 ? parsed : 256) * MiB,
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
