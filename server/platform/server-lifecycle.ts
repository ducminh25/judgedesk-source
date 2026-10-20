import {
  cancelToolchainDiscovery,
  drainToolchainDiscovery,
} from "../toolchains/discovery.js";
import { executorClient } from "../executor/client.js";

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
  private readonly activeBackgroundOperations = new Set<Promise<unknown>>();
  private settledBackgroundErrors: unknown[] = [];

  get isClosing(): boolean {
    return this.draining;
  }

  get acceptsNewJudgeSessions(): boolean {
    return !this.draining;
  }

  get activeJudgeSessionCount(): number {
    return this.activeSessionIds.size;
  }

  get activeBackgroundOperationCount(): number {
    return this.activeBackgroundOperations.size;
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

  assertAdmissible(): void {
    if (this.draining) {
      throw new Error(
        "Cannot admit background operation: lifecycle is closing or closed",
      );
    }
  }

  runBackgroundOperation<T>(workFactory: () => Promise<T>): Promise<T> {
    this.assertAdmissible();
    const op = workFactory();
    this.activeBackgroundOperations.add(op);
    op.catch((err: unknown) => {
      this.settledBackgroundErrors.push(err);
    }).finally(() => {
      this.activeBackgroundOperations.delete(op);
    });
    return op;
  }

  trackBackgroundOperation(op: Promise<unknown>): Promise<unknown> {
    this.assertAdmissible();
    this.activeBackgroundOperations.add(op);
    op.catch((err: unknown) => {
      this.settledBackgroundErrors.push(err);
    }).finally(() => {
      this.activeBackgroundOperations.delete(op);
    });
    return op;
  }

  beginDrain(): void {
    this.draining = true;
  }

  async waitForJudgeSessionsToFinish(timeoutMs: number): Promise<boolean> {
    if (this.activeSessionIds.size === 0) return true;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(drained);
      };
      const onIdle = () => finish(true);
      timer = setTimeout(() => finish(false), timeoutMs);
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

  private drainPromise: Promise<void> | null = null;

  drain(timeoutMs: number = 4000): Promise<void> {
    if (this.drainPromise) {
      return this.drainPromise;
    }
    const promise = this.executeDrain(timeoutMs).catch((error) => {
      if (this.drainPromise === promise && this.activeJudgeSessionCount > 0) {
        this.drainPromise = null;
      }
      throw error;
    });
    this.drainPromise = promise;
    return promise;
  }

  private async executeDrain(timeoutMs: number): Promise<void> {
    this.beginDrain();
    cancelToolchainDiscovery();

    const startTime = Date.now();
    const remainingBudget = () => Math.max(0, timeoutMs - (Date.now() - startTime));

    const errors: unknown[] = [...this.settledBackgroundErrors];

    // Phase 1: Background operations bounded by remainingBudget
    if (this.activeBackgroundOperations.size > 0) {
      const ops = Array.from(this.activeBackgroundOperations);
      const budget = remainingBudget();
      let timer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for ${ops.length} active background operation(s) to finish within ${timeoutMs}ms drain budget`,
            ),
          );
        }, budget);
      });

      try {
        const results = await Promise.race([
          Promise.allSettled(ops),
          timeoutPromise,
        ]);
        for (const res of results) {
          if (res.status === "rejected" && !errors.includes(res.reason)) {
            errors.push(res.reason);
          }
        }
      } catch (timeoutErr) {
        errors.push(timeoutErr);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Phase 2: Discovery drain bounded by remaining budget
    try {
      const budget = remainingBudget();
      if (budget <= 0) {
        errors.push(new Error("Drain budget exhausted before toolchain discovery drain"));
      } else {
        await drainToolchainDiscovery(budget);
      }
    } catch (err) {
      errors.push(err);
    }

    // Phase 3: Judge sessions bounded by remaining budget
    const sessionBudget = remainingBudget();
    let sessionsDrained = this.activeJudgeSessionCount === 0;
    if (!sessionsDrained && sessionBudget <= 0) {
      errors.push(
        new Error(
          `Drain budget exhausted with ${this.activeJudgeSessionCount} active judging session(s) remaining`,
        ),
      );
    } else if (!sessionsDrained) {
      sessionsDrained = await this.waitForJudgeSessionsToFinish(sessionBudget);
      if (!sessionsDrained) {
        errors.push(
          new Error(
            `Timed out waiting for ${this.activeJudgeSessionCount} active judging session(s) to finish`,
          ),
        );
      }
    }

    // Phase 4: Executor shutdown only after all judge sessions have drained
    if (sessionsDrained && this.activeJudgeSessionCount === 0) {
      const execBudget = Math.max(remainingBudget(), Math.min(timeoutMs, 2_000));
      let timer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Executor client shutdown timed out after ${execBudget}ms`));
        }, execBudget);
      });
      try {
        await Promise.race([
          executorClient.shutdown(),
          timeoutPromise,
        ]);
      } catch (err) {
        errors.push(err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (errors.length > 0) {
      const messages = errors.map((e) =>
        e instanceof Error ? e.message : String(e),
      );
      const errorObjects = errors.map((e) =>
        e instanceof Error ? e : new Error(String(e)),
      );
      throw new AggregateError(
        errorObjects,
        `ServerLifecycle.drain() failed with ${errors.length} background/shutdown error(s):\n  ${messages.join("\n  ")}`,
      );
    }
  }

  resetForTests(): void {
    this.draining = false;
    this.drainPromise = null;
    this.activeSessionIds.clear();
    this.idleWaiters.clear();
    this.activeBackgroundOperations.clear();
    this.settledBackgroundErrors = [];
  }
}

export const serverLifecycle = new ServerLifecycle();
