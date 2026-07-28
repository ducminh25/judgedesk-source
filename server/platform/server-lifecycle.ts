export interface JudgeSessionLease {
  readonly sessionId: string;
  finish(): void;
}

export type JudgeSessionAdmission =
  | { accepted: true; lease: JudgeSessionLease }
  | { accepted: false; reason: "draining" | "duplicate" };

type IdleWaiter = () => void;

export class ServerLifecycle {
  private draining = false;
  private readonly activeSessionIds = new Set<string>();
  private readonly idleWaiters = new Set<IdleWaiter>();

  get acceptsNewJudgeSessions(): boolean {
    return !this.draining;
  }

  get activeJudgeSessionCount(): number {
    return this.activeSessionIds.size;
  }

  tryStartJudgeSession(sessionId: string): JudgeSessionAdmission {
    if (this.draining) return { accepted: false, reason: "draining" };
    if (this.activeSessionIds.has(sessionId)) {
      return { accepted: false, reason: "duplicate" };
    }

    this.activeSessionIds.add(sessionId);
    let finished = false;
    return {
      accepted: true,
      lease: {
        sessionId,
        finish: () => {
          if (finished) return;
          finished = true;
          this.finishJudgeSession(sessionId);
        },
      },
    };
  }

  beginDrain(): void {
    this.draining = true;
  }

  async waitForJudgeSessionsToFinish(timeoutMs: number): Promise<boolean> {
    if (this.activeSessionIds.size === 0) return true;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(drained);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.idleWaiters.add(onIdle);
    });
  }

  private finishJudgeSession(sessionId: string): void {
    if (!this.activeSessionIds.delete(sessionId)) return;
    if (this.activeSessionIds.size !== 0) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const waiter of waiters) waiter();
  }
}

export const serverLifecycle = new ServerLifecycle();
