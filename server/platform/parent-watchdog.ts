type ProcessProbe = (pid: number, signal: 0) => void;

function parseParentPid(rawPid: string | undefined): number | undefined {
  if (!rawPid || !/^\d+$/.test(rawPid)) return undefined;
  const pid = Number(rawPid);
  return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid ? pid : undefined;
}

export function parentProcessIsMissing(
  rawPid: string | undefined,
  probe: ProcessProbe = process.kill.bind(process),
): boolean {
  const pid = parseParentPid(rawPid);
  if (pid === undefined) return false;

  try {
    probe(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error
      && "code" in error
      && error.code === "ESRCH";
  }
}

export function startParentWatchdog(
  rawPid: string | undefined,
  onParentExit: () => void | Promise<void>,
  intervalMs = 1_000,
): ReturnType<typeof setInterval> | undefined {
  if (parseParentPid(rawPid) === undefined) return undefined;

  let handlingExit = false;
  const timer = setInterval(() => {
    if (handlingExit || !parentProcessIsMissing(rawPid)) return;
    handlingExit = true;
    clearInterval(timer);
    void onParentExit();
  }, intervalMs);
  timer.unref();
  return timer;
}
