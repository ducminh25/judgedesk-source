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

test("missing local execution policy defaults to strict isolation", () => {
  withTemporaryAppData(() => {
    assert.deepEqual(loadLocalExecutionPolicy(), {
      schemaVersion: 1,
      allowResourceOnlyLocalExecution: false,
      status: "default",
    });
  });
});

test("strict policy round-trip persists only the explicit false boolean", () => {
  withTemporaryAppData(() => {
    assert.equal(
      saveLocalExecutionPolicy(false).allowResourceOnlyLocalExecution,
      false,
    );
    assert.deepEqual(loadLocalExecutionPolicy(), {
      schemaVersion: 1,
      allowResourceOnlyLocalExecution: false,
      status: "ready",
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(getLocalExecutionPolicyFilePath(), "utf8")),
      { schemaVersion: 1, allowResourceOnlyLocalExecution: false },
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
      allowResourceOnlyLocalExecution: false,
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
      false,
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
    assert.equal(policy.allowResourceOnlyLocalExecution, false);
  });
});

test("legacy true is disabled with a diagnostic without rewriting the document", () => {
  withTemporaryAppData(() => {
    const filePath = getLocalExecutionPolicyFilePath();
    const legacy = '{ "schemaVersion": 1, "allowResourceOnlyLocalExecution": true }\n';
    fs.writeFileSync(filePath, legacy, "utf8");
    assert.deepEqual(loadLocalExecutionPolicy(), {
      schemaVersion: 1,
      allowResourceOnlyLocalExecution: false,
      status: "recovery",
      diagnostic: "RESOURCE_ONLY_LOCAL_EXECUTION_DISABLED",
    });
    assert.equal(fs.readFileSync(filePath, "utf8"), legacy);
  });
});

test("saving true is rejected before creating or replacing any policy bytes", () => {
  withTemporaryAppData(() => {
    const filePath = getLocalExecutionPolicyFilePath();
    assert.throws(() => saveLocalExecutionPolicy(true), /resource-only.*disabled/i);
    assert.equal(fs.existsSync(filePath), false);
    saveLocalExecutionPolicy(false);
    const before = fs.readFileSync(filePath);
    assert.throws(() => saveLocalExecutionPolicy(true), /resource-only.*disabled/i);
    assert.deepEqual(fs.readFileSync(filePath), before);
    assert.deepEqual(fs.readdirSync(path.dirname(filePath)), [path.basename(filePath)]);
  });
});

test("oversized policy is read with a bounded descriptor, not a whole-file allocation", (t) => {
  withTemporaryAppData(() => {
    const filePath = getLocalExecutionPolicyFilePath();
    fs.writeFileSync(filePath, "x".repeat(512 * 1024), "utf8");
    const readSync = fs.readSync;
    let readBytes = 0;
    t.mock.method(fs, "readFileSync", () => {
      throw new Error("Whole-file policy reads are forbidden");
    });
    t.mock.method(fs, "readSync", (
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      assert.ok(length <= 4 * 1024 + 1);
      const count = readSync(descriptor, buffer, offset, length, position);
      readBytes += count;
      return count;
    });
    assert.deepEqual(loadLocalExecutionPolicy(), {
      schemaVersion: 1,
      allowResourceOnlyLocalExecution: false,
      status: "recovery",
      diagnostic: "INVALID_POLICY_DOCUMENT",
    });
    assert.ok(readBytes <= 4 * 1024 + 1);
  });
});

test("directory and descriptor read failures remain strict and close owned handles", (t) => {
  withTemporaryAppData(() => {
    const filePath = getLocalExecutionPolicyFilePath();
    fs.mkdirSync(filePath);
    assert.deepEqual(loadLocalExecutionPolicy(), {
      schemaVersion: 1,
      allowResourceOnlyLocalExecution: false,
      status: "recovery",
      diagnostic: "POLICY_READ_FAILED",
    });
    fs.rmdirSync(filePath);
    fs.writeFileSync(filePath, '{"schemaVersion":1,"allowResourceOnlyLocalExecution":false}', "utf8");
    const closeSync = fs.closeSync;
    let closed = 0;
    t.mock.method(fs, "readSync", () => { throw new Error("simulated read failure"); });
    t.mock.method(fs, "closeSync", (descriptor: number) => {
      closed += 1;
      closeSync(descriptor);
    });
    const policy = loadLocalExecutionPolicy();
    assert.equal(policy.allowResourceOnlyLocalExecution, false);
    assert.equal(policy.diagnostic, "POLICY_READ_FAILED");
    assert.equal(closed, 1);
  });
});

test("the 4 KiB document boundary accepts valid strict JSON but not one extra byte", () => {
  withTemporaryAppData(() => {
    const filePath = getLocalExecutionPolicyFilePath();
    const json = '{"schemaVersion":1,"allowResourceOnlyLocalExecution":false}';
    const document = json.padEnd(4 * 1024, " ");
    fs.writeFileSync(filePath, document, "utf8");
    assert.equal(loadLocalExecutionPolicy().status, "ready");
    fs.writeFileSync(filePath, `${document} `, "utf8");
    assert.equal(loadLocalExecutionPolicy().diagnostic, "INVALID_POLICY_DOCUMENT");
  });
});

test("policy descriptor opens nonblocking when the host provides that flag", (t) => {
  withTemporaryAppData(() => {
    fs.writeFileSync(getLocalExecutionPolicyFilePath(),
      '{"schemaVersion":1,"allowResourceOnlyLocalExecution":false}', "utf8");
    const openSync = fs.openSync;
    t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      assert.equal(typeof flags, "number", "use the supported descriptor flags, not a blocking string mode");
      if (typeof flags === "number" && fs.constants.O_NONBLOCK !== undefined) {
        assert.equal(flags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK);
      }
      return openSync(file, flags, mode);
    });
    assert.equal(loadLocalExecutionPolicy().status, "ready");
  });
});
