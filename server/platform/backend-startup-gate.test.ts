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
  input.end(`${token.slice(32)}\n`);
  await waiting;
});

test("backend startup gate rejects EOF, trailing data, and timeout", async () => {
  const eof = new PassThrough();
  const eofResult = awaitBackendStartupGateFrom(eof, token, 1_000);
  eof.end();
  await assert.rejects(eofResult, /BACKEND_STARTUP_GATE_EOF/);

  const trailing = new PassThrough();
  const trailingResult = awaitBackendStartupGateFrom(trailing, token, 1_000);
  trailing.end(`JUDGEDESK_START/1 ${token}\nextra`);
  await assert.rejects(trailingResult, /BACKEND_STARTUP_GATE_TRAILING_DATA/);

  const timeout = new PassThrough();
  await assert.rejects(
    awaitBackendStartupGateFrom(timeout, token, 10),
    /BACKEND_STARTUP_GATE_TIMEOUT/,
  );
  timeout.destroy();
});
