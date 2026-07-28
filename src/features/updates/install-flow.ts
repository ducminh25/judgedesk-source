export type UpdateInstallPhase = "prepare" | "install" | "relaunch";

export interface UpdateInstallFlowDependencies {
  prepare(): Promise<void>;
  install(): Promise<void>;
  relaunch(): Promise<void>;
}

export class UpdateInstallFlowError extends Error {
  readonly phase: UpdateInstallPhase;

  constructor(phase: UpdateInstallPhase, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "UpdateInstallFlowError";
    this.phase = phase;
    this.cause = cause;
  }
}

async function runStep(
  phase: UpdateInstallPhase,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw new UpdateInstallFlowError(phase, error);
  }
}

export async function runUpdateInstallFlow(
  dependencies: UpdateInstallFlowDependencies,
): Promise<void> {
  await runStep("prepare", dependencies.prepare);
  await runStep("install", dependencies.install);
  await runStep("relaunch", dependencies.relaunch);
}
