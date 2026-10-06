type DiagnosticContext = Readonly<Record<string, string | number | boolean | undefined>>;

export function logJudgeDiagnostic(context: DiagnosticContext): void {
  if (process.env.JUDGEDESK_JUDGE_TRACE !== "1") return;
  console.info(`[Judge Diagnostic] ${JSON.stringify({
    at: new Date().toISOString(), backendPid: process.pid, ...context,
  })}`);
}

export async function measureDiagnosticPhase<T>(
  context: DiagnosticContext,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let status = "failed";
  try {
    const result = await operation();
    status = "completed";
    return result;
  } finally {
    logJudgeDiagnostic({ ...context, status, durationMs: performance.now() - started });
  }
}
