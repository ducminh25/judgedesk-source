import type { Readable } from "node:stream";

const GATE_PREFIX = "JUDGEDESK_START/1 ";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MAX_GATE_BYTES = 128;
const GATE_TIMEOUT_MS = 10_000;

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
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let input = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("BACKEND_STARTUP_GATE_TIMEOUT")),
      timeoutMs,
    );

    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer | string) => {
      input = Buffer.concat([
        input,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      if (input.length > MAX_GATE_BYTES) {
        finish(new Error("BACKEND_STARTUP_GATE_TOO_LARGE"));
        return;
      }
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== input.length - 1) {
        finish(new Error("BACKEND_STARTUP_GATE_TRAILING_DATA"));
        return;
      }
      try {
        validateBackendStartupGate(input, expectedToken);
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onEnd = () => finish(new Error("BACKEND_STARTUP_GATE_EOF"));
    const onError = (error: Error) => finish(error);

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.resume();
  });
}

export async function awaitBackendStartupGate(): Promise<void> {
  const expectedToken = takeBackendStartupToken();
  await awaitBackendStartupGateFrom(process.stdin, expectedToken);
}
