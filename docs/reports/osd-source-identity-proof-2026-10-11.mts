// Read-only product diagnostic. Only disposable fixture files are created.
// Run: node --import tsx docs/reports/osd-source-identity-proof-2026-10-11.mts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OsdWatcher } from "../../server/judge/osd-watcher.js";
import type { OsdJob } from "../../server/judge/osd-types.js";

const tempParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, "judgedesk-osd-identity-proof-"));
const osdPath = path.join(root, "OSD");
const contestantsPath = path.join(root, "Contestants");
fs.mkdirSync(osdPath);
fs.mkdirSync(contestantsPath);
const jobs: OsdJob[] = [];
const errors: string[] = [];
const watcher = new OsdWatcher({
  osdPath,
  contestantsPath,
  getValidProblems: () => ["SUM"],
  onSubmissionIngested: (job) => jobs.push(job),
  onError: (error) => errors.push(String(error)),
  enableLog: false,
  debounceMs: 5,
  pollIntervalMs: 100,
});

async function ingest(extension: string, source: string, expectedCount: number): Promise<void> {
  fs.writeFileSync(path.join(osdPath, `[HS01][SUM].${extension}`), source);
  await watcher.scanDirectory();
  const deadline = Date.now() + 5000;
  while (jobs.length < expectedCount && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(jobs.length, expectedCount, `ingest count; errors: ${errors.join("; ")}`);
}

try {
  watcher.start();
  await ingest("cpp", "// source A\n", 1);
  const firstJob = jobs[0];
  assert.ok(firstJob);
  const firstBytesAtArrival = fs.readFileSync(firstJob.filePath, "utf8");
  assert.equal(firstBytesAtArrival, "// source A\n");

  await ingest("cpp", "// source B\n", 2);
  const secondJob = jobs[1];
  assert.ok(secondJob);
  const firstBytesAfterResubmit = fs.readFileSync(firstJob.filePath, "utf8");
  assert.equal(firstJob.filePath, secondJob.filePath);
  assert.equal(firstBytesAfterResubmit, "// source B\n");
  assert.notEqual(firstBytesAtArrival, firstBytesAfterResubmit);

  await ingest("pas", "{ source C }\n", 3);
  assert.equal(fs.existsSync(firstJob.filePath), false);
  assert.equal(errors.length, 0);

  console.log(JSON.stringify({
    proof: "OSD queued job path is not an immutable source identity",
    jobs: jobs.length,
    firstSourceAtArrival: firstBytesAtArrival.trim(),
    firstSourceAfterSameLanguageResubmit: firstBytesAfterResubmit.trim(),
    samePathForFirstAndSecondJob: true,
    firstPathExistsAfterLanguageChange: false,
    boundary: "watcher ingest and retained OsdJob; no compiler, judge session or scoreboard run",
  }, null, 2));
} finally {
  watcher.stop();
  const resolvedRoot = fs.realpathSync(root);
  assert.equal(path.dirname(resolvedRoot), tempParent);
  assert.ok(path.basename(resolvedRoot).startsWith("judgedesk-osd-identity-proof-"));
  fs.rmSync(resolvedRoot, { recursive: true });
}
