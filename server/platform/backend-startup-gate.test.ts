import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  awaitBackendStartupGateFrom,
  takeBackendStartupToken,
  validateBackendStartupGate,
} from "./backend-startup-gate";

const token = "ab".repeat(32);

test("backend startup gate accepts only the exact authenticated frame", () => {
  assert.doesNotThrow(() => {
    validateBackendStartupGate(
      Buffer.from(`JUDGEDESK_START/1 ${token}\n`, "ascii"),
      token,
    );
  });
  assert.throws(
    () => validateBackendStartupGate(Buffer.from(`JUDGEDESK_START/1 ${token}`), token),
    /BACKEND_STARTUP_GATE_MISMATCH/,
  );
  assert.throws(
    () => validateBackendStartupGate(Buffer.from(`JUDGEDESK_START/1 ${"cd".repeat(32)}\n`), token),
    /BACKEND_STARTUP_GATE_MISMATCH/,
  );
  assert.throws(
    () => validateBackendStartupGate(Buffer.alloc(129, 0x61), token),
    /BACKEND_STARTUP_GATE_TOO_LARGE/,
  );
});

test("backend startup gate rejects malformed expected tokens", () => {
  assert.throws(
    () => validateBackendStartupGate(Buffer.from("JUDGEDESK_START/1 short\n"), "short"),
    /BACKEND_STARTUP_GATE_INVALID_TOKEN/,
  );
});

test("backend startup gate fails closed without a token and consumes a valid token", () => {
  const missing: NodeJS.ProcessEnv = {};
  assert.throws(
    () => takeBackendStartupToken(missing),
    /BACKEND_STARTUP_GATE_MISSING/,
  );

  const environment: NodeJS.ProcessEnv = {
    JUDGEDESK_BOOTSTRAP_TOKEN: token,
  };
  assert.equal(takeBackendStartupToken(environment), token);
  assert.equal(environment.JUDGEDESK_BOOTSTRAP_TOKEN, undefined);
});

test("backend startup gate accepts a fragmented frame", async () => {
  const input = new PassThrough();
  const waiting = awaitBackendStartupGateFrom(input, token, 1_000);
  input.write("JUDGEDESK_START/1 ");
  input.write(`${token.slice(0, 32)}`);
  input.write(`${token.slice(32)}\n`);
  const parentLiveness = await waiting;
  const losses: string[] = [];
  parentLiveness.onParentLost((error) => losses.push(error.message));
  assert.deepEqual(losses, []);
  input.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(losses, ["BACKEND_PARENT_CHANNEL_EOF"]);
});

test("backend startup gate rejects EOF and timeout before authentication", async () => {
  const eof = new PassThrough();
  const eofResult = awaitBackendStartupGateFrom(eof, token, 1_000);
  eof.end();
  await assert.rejects(eofResult, /BACKEND_STARTUP_GATE_EOF/);

  const timeout = new PassThrough();
  await assert.rejects(
    awaitBackendStartupGateFrom(timeout, token, 10),
    /BACKEND_STARTUP_GATE_TIMEOUT/,
  );
  timeout.destroy();
});

test("parent liveness reports coalesced trailing data exactly once", async () => {
  const input = new PassThrough();
  const parentLiveness = awaitBackendStartupGateFrom(input, token, 1_000);
  input.write(`JUDGEDESK_START/1 ${token}\nextra`);
  const channel = await parentLiveness;
  const losses: string[] = [];
  channel.onParentLost((error) => losses.push(error.message));
  input.end("more");
  input.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(losses, ["BACKEND_PARENT_CHANNEL_TRAILING_DATA"]);
});

test("parent liveness reports later data, EOF, close, or error exactly once", async (t) => {
  const cases: Array<{
    name: string;
    expected: RegExp;
    trigger(input: PassThrough): void;
  }> = [
    {
      name: "trailing data",
      expected: /BACKEND_PARENT_CHANNEL_TRAILING_DATA/,
      trigger: (input) => {
        input.write("unexpected");
        input.end();
      },
    },
    {
      name: "EOF",
      expected: /BACKEND_PARENT_CHANNEL_EOF/,
      trigger: (input) => input.end(),
    },
    {
      name: "close",
      expected: /BACKEND_PARENT_CHANNEL_CLOSED/,
      trigger: (input) => input.emit("close"),
    },
    {
      name: "error",
      expected: /BACKEND_PARENT_CHANNEL_ERROR: pipe failed/,
      trigger: (input) => input.emit("error", new Error("pipe failed")),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const input = new PassThrough();
      const waiting = awaitBackendStartupGateFrom(input, token, 1_000);
      input.write(`JUDGEDESK_START/1 ${token}\n`);
      const channel = await waiting;
      const losses: Error[] = [];
      channel.onParentLost((error) => losses.push(error));
      testCase.trigger(input);
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.emit("close");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(losses.length, 1);
      assert.match(losses[0].message, testCase.expected);
      input.destroy();
    });
  }
});

test("parent liveness accepts only one callback", async () => {
  const input = new PassThrough();
  const waiting = awaitBackendStartupGateFrom(input, token, 1_000);
  input.write(`JUDGEDESK_START/1 ${token}\n`);
  const channel = await waiting;
  channel.onParentLost(() => {});
  assert.throws(
    () => channel.onParentLost(() => {}),
    /BACKEND_PARENT_CHANNEL_HANDLER_ALREADY_SET/,
  );
  input.destroy();
});
