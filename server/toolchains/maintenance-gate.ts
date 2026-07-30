import { serverLifecycle } from "../platform/server-lifecycle.js";

export interface ToolchainMaintenanceLease {
  readonly operationId: string;
  finish(): void;
}

export interface ToolchainJudgeLease {
  readonly operationId: string;
  finish(): void;
}

export class ToolchainMaintenanceGate {
  private activeOperationId: string | null = null;
  private readonly activeJudgeOperationIds = new Set<string>();

  constructor(
    private readonly activeJudgeSessionCount: () => number = () =>
      serverLifecycle.activeJudgeSessionCount,
  ) {}

  get active(): boolean {
    return this.activeOperationId !== null;
  }

  get locked(): boolean {
    return this.activeOperationId !== null || this.activeJudgeOperationIds.size > 0;
  }

  tryAcquire(operationId: string): ToolchainMaintenanceLease | null {
    if (
      !operationId
      || this.activeOperationId
      || this.activeJudgeOperationIds.size > 0
      || this.activeJudgeSessionCount() > 0
    ) {
      return null;
    }
    this.activeOperationId = operationId;
    let finished = false;
    return {
      operationId,
      finish: () => {
        if (finished) return;
        finished = true;
        if (this.activeOperationId === operationId) this.activeOperationId = null;
      },
    };
  }

  tryAcquireJudge(operationId: string): ToolchainJudgeLease | null {
    if (
      !operationId
      || this.activeOperationId
      || this.activeJudgeOperationIds.has(operationId)
    ) {
      return null;
    }
    this.activeJudgeOperationIds.add(operationId);
    let finished = false;
    return {
      operationId,
      finish: () => {
        if (finished) return;
        finished = true;
        this.activeJudgeOperationIds.delete(operationId);
      },
    };
  }
}

export const toolchainMaintenanceGate = new ToolchainMaintenanceGate();
