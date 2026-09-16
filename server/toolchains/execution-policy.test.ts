import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getLocalExecutionPolicyFilePath,
  loadLocalExecutionPolicy,
  saveLocalExecutionPolicy,
} from "./execution-policy.js";

function withTemporaryAppData(run: (directory: string) => void): void {
  const previous = process.env.THEMIS_APP_DATA_DIR;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-execution-policy-"),
  );
  process.env.THEMIS_APP_DATA_DIR = directory;
  try {
    run(directory);
  } finally {
    if (previous === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("local resource-only execution defaults to true when no policy exists", () => {
  withTemporaryAppData(() => {
    assert.deepEqual(loadLocalExecutionPolicy(), {
      schemaVersion: 1,
      allowResourceOnlyLocalExecution: true,
      status: "default",
    });
  });
});

test("policy round-trip persists only the explicit boolean", () => {
  withTemporaryAppData(() => {
    assert.equal(
      saveLocalExecutionPolicy(true).allowResourceOnlyLocalExecution,
      true,
    );
    assert.deepEqual(loadLocalExecutionPolicy(), {
      schemaVersion: 1,
      allowResourceOnlyLocalExecution: true,
      status: "ready",
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(getLocalExecutionPolicyFilePath(), "utf8")),
      { schemaVersion: 1, allowResourceOnlyLocalExecution: true },
    );

    saveLocalExecutionPolicy(false);
    assert.equal(
      loadLocalExecutionPolicy().allowResourceOnlyLocalExecution,
      false,
    );
  });
});

test("invalid, oversized, and future policy documents fail safe to default", () => {
  withTemporaryAppData(() => {
    const filePath = getLocalExecutionPolicyFilePath();
    fs.writeFileSync(filePath, "{not-json", "utf8");
    assert.deepEqual(loadLocalExecutionPolicy(), {
      schemaVersion: 1,
      allowResourceOnlyLocalExecution: true,
      status: "recovery",
      diagnostic: "INVALID_POLICY_DOCUMENT",
    });

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        allowResourceOnlyLocalExecution: true,
      }),
      "utf8",
    );
    assert.equal(
      loadLocalExecutionPolicy().allowResourceOnlyLocalExecution,
      true,
    );

    fs.writeFileSync(filePath, "x".repeat(4 * 1024 + 1), "utf8");
    assert.equal(loadLocalExecutionPolicy().status, "recovery");
  });
});

test("unknown keys recover to safe default", () => {
  withTemporaryAppData(() => {
    fs.writeFileSync(
      getLocalExecutionPolicyFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        allowResourceOnlyLocalExecution: true,
        allowNetwork: true,
      }),
      "utf8",
    );
    const policy = loadLocalExecutionPolicy();
    assert.equal(policy.status, "recovery");
    assert.equal(policy.allowResourceOnlyLocalExecution, true);
  });
});
