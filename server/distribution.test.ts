import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getJudgeDeskDistribution } from "./distribution.js";

test("distribution identity is explicit and malformed metadata falls back to development", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-distribution-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(
    getJudgeDeskDistribution({ environment: {}, resourceRoot: root }),
    "development",
  );
  fs.writeFileSync(
    path.join(root, "judgedesk-distribution.json"),
    JSON.stringify({ schemaVersion: 1, distribution: "full" }),
  );
  assert.equal(
    getJudgeDeskDistribution({ environment: {}, resourceRoot: root }),
    "full",
  );
  fs.writeFileSync(
    path.join(root, "judgedesk-distribution.json"),
    JSON.stringify({ schemaVersion: 1, distribution: "full", unknown: true }),
  );
  assert.equal(
    getJudgeDeskDistribution({ environment: {}, resourceRoot: root }),
    "development",
  );
  assert.equal(
    getJudgeDeskDistribution({
      environment: { JUDGEDESK_DISTRIBUTION: "core" },
      resourceRoot: root,
    }),
    "core",
  );
});
