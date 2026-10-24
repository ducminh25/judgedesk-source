import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parsePublisherPin } from "./resolve-publisher-pin.mjs";
test("publisher pin never accepts a floating branch, arbitrary repository or partial SHA", () => {
  const valid = { sourceRepo: "ducminh25/judgedesk-source", sourceCommit: "a".repeat(40) };
  assert.equal(parsePublisherPin(JSON.stringify(valid)).sourceCommit, valid.sourceCommit);
  for (const invalid of [{ ...valid, sourceCommit: "main" }, { ...valid, sourceCommit: "a".repeat(39) }, { ...valid, sourceRepo: "attacker/tools" }, { ...valid, extra: true }]) assert.throws(() => parsePublisherPin(JSON.stringify(invalid)));
});
test("staged workflow keeps PR/build unsigned, signing isolated and deployment dependent on signing", async () => {
  const workflow = await readFile(new URL("./distribution/.github/workflows/announcements-pages.yml", import.meta.url), "utf8");
  const build = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  sign:"));
  const sign = workflow.slice(workflow.indexOf("  sign:"), workflow.indexOf("  deploy:"));
  const deploy = workflow.slice(workflow.indexOf("  deploy:"));
  assert.ok(!build.includes("secrets.")); assert.ok(!build.includes("pages: write"));
  assert.ok(sign.includes("environment: announcements-signing")); assert.doesNotMatch(sign, /^\s*(?:run:\s*)?npm\s/m);
  assert.ok(deploy.includes("needs: [build, sign]")); assert.ok(!deploy.includes("secrets."));
  assert.ok(deploy.includes("predeploy")); assert.ok(deploy.includes("smoke"));
  assert.ok(workflow.includes("cancel-in-progress: false")); assert.ok(!workflow.includes("pull_request_target"));
  for (const action of workflow.matchAll(/uses: ([^\s#]+)/g)) assert.match(action[1], /^[a-zA-Z0-9_/-]+@[0-9a-f]{40}$/);
  assert.ok(build.indexOf("Require an explicit full source pin") < build.indexOf("name: Checkout approved resolver"));
});
