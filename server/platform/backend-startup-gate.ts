import type { Readable } from "node:stream";

const GATE_PREFIX = "JUDGEDESK_START/1 ";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MAX_GATE_BYTES = 128;
const GATE_TIMEOUT_MS = 10_000;

export type BackendParentLostHandler = (error: Error) => void;

export interface BackendParentLiveness {
  onParentLost(handler: BackendParentLostHandler): void;
}

class BackendParentLivenessChannel implements BackendParentLiveness {
  private handler: BackendParentLostHandler | null = null;
  private loss: Error | null = null;
  private notified = false;

  onParentLost(handler: BackendParentLostHandler): void {
    if (this.handler) {
      throw new Error("BACKEND_PARENT_CHANNEL_HANDLER_ALREADY_SET");
    }
    this.handler = handler;
    this.notify();
  }

  reportLoss(error: Error): void {
    if (this.loss) return;
    this.loss = error;
    this.notify();
  }

  private notify(): void {
    if (this.notified || !this.handler || !this.loss) return;
    this.notified = true;
    this.handler(this.loss);
  }
}

export function validateBackendStartupGate(input: Buffer, expectedToken: string): void {
  if (!TOKEN_PATTERN.test(expectedToken)) {
    throw new Error("BACKEND_STARTUP_GATE_INVALID_TOKEN");
  }
  if (input.length > MAX_GATE_BYTES) {
    throw new Error("BACKEND_STARTUP_GATE_TOO_LARGE");
  }
  const expected = Buffer.from(`${GATE_PREFIX}${expectedToken}\n`, "ascii");
  if (input.length !== expected.length || !input.equals(expected)) {
    throw new Error("BACKEND_STARTUP_GATE_MISMATCH");
  }
}

export function takeBackendStartupToken(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const expectedToken = environment.JUDGEDESK_BOOTSTRAP_TOKEN;
  if (expectedToken === undefined) {
    throw new Error("BACKEND_STARTUP_GATE_MISSING");
  }
  delete environment.JUDGEDESK_BOOTSTRAP_TOKEN;
  return expectedToken;
}

export async function awaitBackendStartupGateFrom(
  stream: Readable,
  expectedToken: string,
  timeoutMs = GATE_TIMEOUT_MS,
): Promise<BackendParentLiveness> {
  return new Promise<BackendParentLiveness>((resolve, reject) => {
    let input = Buffer.alloc(0);
    let settled = false;
    const parentLiveness = new BackendParentLivenessChannel();
    const timer = setTimeout(
      () => fail(new Error("BACKEND_STARTUP_GATE_TIMEOUT")),
      timeoutMs,
    );

    const cleanupStartupListeners = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners();
      stream.pause();
      reject(error);
    };
    const armParentLiveness = (trailingData: boolean) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners();

      let lost = false;
      const cleanupLivenessListeners = () => {
        stream.off("data", onParentData);
        stream.off("end", onParentEnd);
        stream.off("close", onParentClose);
        stream.off("error", onParentError);
      };
      const reportParentLoss = (error: Error) => {
        if (lost) return;
        lost = true;
        cleanupLivenessListeners();
        stream.pause();
        parentLiveness.reportLoss(error);
      };
      const onParentData = (chunk: Buffer | string) => {
        if ((Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)) === 0) {
          return;
        }
        reportParentLoss(new Error("BACKEND_PARENT_CHANNEL_TRAILING_DATA"));
      };
      const onParentEnd = () =>
        reportParentLoss(new Error("BACKEND_PARENT_CHANNEL_EOF"));
      const onParentClose = () =>
        reportParentLoss(new Error("BACKEND_PARENT_CHANNEL_CLOSED"));
      const onParentError = (error: Error) =>
        reportParentLoss(
          new Error(`BACKEND_PARENT_CHANNEL_ERROR: ${error.message}`),
        );

      stream.on("data", onParentData);
      stream.once("end", onParentEnd);
      stream.once("close", onParentClose);
      stream.once("error", onParentError);
      stream.resume();
      resolve(parentLiveness);

      if (trailingData) {
        reportParentLoss(new Error("BACKEND_PARENT_CHANNEL_TRAILING_DATA"));
      }
    };
    const onData = (chunk: Buffer | string) => {
      input = Buffer.concat([
        input,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      const newline = input.indexOf(0x0a);
      if (newline < 0) {
        if (input.length > MAX_GATE_BYTES) {
          fail(new Error("BACKEND_STARTUP_GATE_TOO_LARGE"));
        }
        return;
      }
      const gate = input.subarray(0, newline + 1);
      try {
        validateBackendStartupGate(gate, expectedToken);
        armParentLiveness(newline !== input.length - 1);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onEnd = () => fail(new Error("BACKEND_STARTUP_GATE_EOF"));
    const onClose = () => fail(new Error("BACKEND_STARTUP_GATE_CLOSED"));
    const onError = (error: Error) => fail(error);

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
    stream.resume();
  });
}

export async function awaitBackendStartupGate(): Promise<BackendParentLiveness> {
  const expectedToken = takeBackendStartupToken();
  return awaitBackendStartupGateFrom(process.stdin, expectedToken);
}
