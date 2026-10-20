import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OsdWatcher } from "./osd-watcher.js";
import type { OsdJob } from "./osd-types.js";

async function waitForJobs(jobs: OsdJob[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && jobs.length < count; ++attempt) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(jobs.length, count, "watcher did not finish accepting the submitted source");
}

describe("osd-watcher", () => {
  it("does not merge distinct contestant identities through case-insensitive directory aliases", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_osd_alias_"));
    const inbox = path.join(root, "osd");
    const contestants = path.join(root, "contestants");
    fs.mkdirSync(inbox);
    fs.mkdirSync(contestants);
    fs.mkdirSync(path.join(contestants, "HS01"));
    const aliases = fs.existsSync(path.join(contestants, "hs01"));
    const jobs: OsdJob[] = [];
    const errors: string[] = [];
    const watcher = new OsdWatcher({ osdPath: inbox, contestantsPath: contestants, getValidProblems: () => ["SUM"],
      onSubmissionIngested: job => jobs.push(job), onError: error => errors.push(String(error)), debounceMs: 1, pollIntervalMs: 60_000 });
    try {
      watcher.start();
      fs.writeFileSync(path.join(inbox, "0[hs01][SUM]cpp"), "B");
      await watcher.scanDirectory();
      assert.equal(jobs.length, aliases ? 0 : 1);
      if (aliases) {
        assert.ok(errors.some(error => error.includes("IDENTITY_ALIAS")));
        assert.deepEqual(fs.readdirSync(path.join(contestants, "HS01")), []);
      }
    } finally {
      watcher.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the source of every accepted job unchanged across resubmission and language changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_osd_identity_"));
    const inbox = path.join(root, "osd");
    const contestants = path.join(root, "contestants");
    fs.mkdirSync(inbox);
    fs.mkdirSync(contestants);
    const jobs: OsdJob[] = [];
    const watcher = new OsdWatcher({ osdPath: inbox, contestantsPath: contestants, getValidProblems: () => ["SUM"],
      onSubmissionIngested: job => jobs.push(job), debounceMs: 5, pollIntervalMs: 60_000 });
    try {
      watcher.start();
      for (const [name, source] of [["0[HS01][SUM]cpp", "// A"], ["0[HS01][SUM]cpp", "// B"], ["0[HS01][SUM]py", "# C"]]) {
        fs.writeFileSync(path.join(inbox, name), source);
        await watcher.scanDirectory();
        await waitForJobs(jobs, name.endsWith("py") ? 3 : source === "// A" ? 1 : 2);
      }
      assert.equal(jobs.length, 3);
      assert.equal(new Set(jobs.map(job => job.filePath)).size, 3);
      assert.deepEqual(jobs.map(job => fs.readFileSync(job.filePath, "utf8")), ["// A", "// B", "# C"]);
      assert.equal(fs.readFileSync(path.join(contestants, "HS01", "SUM.py"), "utf8"), "# C");
    } finally {
      watcher.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not ingest a file still changing after the retry budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_osd_unstable_"));
    const inbox = path.join(root, "osd");
    const contestants = path.join(root, "contestants");
    fs.mkdirSync(inbox);
    fs.mkdirSync(contestants);
    const jobs: OsdJob[] = [];
    const errors: string[] = [];
    const watcher = new OsdWatcher({ osdPath: inbox, contestantsPath: contestants, getValidProblems: () => ["SUM"],
      onSubmissionIngested: job => jobs.push(job), onError: error => errors.push(String(error)),
      debounceMs: 40, maxLockRetries: 1, pollIntervalMs: 60_000 });
    const source = path.join(inbox, "0[HS01][SUM]cpp");
    let writer: ReturnType<typeof setInterval> | undefined;
    let descriptor: number | undefined;
    try {
      watcher.start();
      fs.writeFileSync(source, "AAAA");
      descriptor = fs.openSync(source, "r+");
      writer = setInterval(() => {
        if (descriptor !== undefined) fs.writeSync(descriptor, "BBBB", 0, "utf8");
      }, 5);
      await watcher.scanDirectory();
      assert.equal(jobs.length, 0, "same-sized writes must not be treated as a stable submission");
      assert.ok(errors.some(error => error.includes("SOURCE_NOT_STABLE")));
    } finally {
      clearInterval(writer);
      if (descriptor !== undefined) fs.closeSync(descriptor);
      watcher.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow contestant-directory junctions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_osd_junction_"));
    const inbox = path.join(root, "osd");
    const contestants = path.join(root, "contestants");
    const outside = path.join(root, "outside");
    for (const directory of [inbox, contestants, outside]) fs.mkdirSync(directory);
    fs.symlinkSync(outside, path.join(contestants, "HS01"), "junction");
    const jobs: OsdJob[] = [];
    const watcher = new OsdWatcher({ osdPath: inbox, contestantsPath: contestants, getValidProblems: () => ["SUM"],
      onSubmissionIngested: job => jobs.push(job), debounceMs: 5, pollIntervalMs: 60_000 });
    try {
      watcher.start();
      fs.writeFileSync(path.join(inbox, "0[HS01][SUM]cpp"), "// private source");
      await watcher.scanDirectory();
      assert.equal(jobs.length, 0);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      watcher.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ingests valid submission, moves to contestant folder and archives history", async () => {
    const rootTemp = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_watcher_test_"));
    const osdDir = path.join(rootTemp, "OSD");
    const contestantsDir = path.join(rootTemp, "Contestants");

    fs.mkdirSync(osdDir, { recursive: true });
    fs.mkdirSync(contestantsDir, { recursive: true });

    const receivedJobs: OsdJob[] = [];
    const newContestantFlags: boolean[] = [];

    const watcher = new OsdWatcher({
      osdPath: osdDir,
      contestantsPath: contestantsDir,
      getValidProblems: () => ["SUM", "GCD"],
      onSubmissionIngested: (job, isNew) => {
        receivedJobs.push(job);
        newContestantFlags.push(isNew);
      },
      debounceMs: 50,
      pollIntervalMs: 200,
    });

    try {
      watcher.start();

      // 1. First submission: HS01 submits SUM.cpp
      const file1 = path.join(osdDir, "[HS01][SUM].cpp");
      fs.writeFileSync(file1, '#include <iostream>\nint main(){ std::cout << "42"; }');

      await watcher.scanDirectory();

      assert.equal(receivedJobs.length, 1);
      assert.equal(receivedJobs[0].contestant, "HS01");
      assert.equal(receivedJobs[0].problem, "SUM");
      assert.equal(newContestantFlags[0], true);

      // Verify file is moved to Contestants/HS01/SUM.cpp
      const destFile1 = path.join(contestantsDir, "HS01", "SUM.cpp");
      assert.equal(fs.existsSync(destFile1), true);
      assert.equal(fs.existsSync(file1), false);

      // 2. Second submission: HS01 changes language to SUM.pas
      const file2 = path.join(osdDir, "[HS01][SUM].pas");
      fs.writeFileSync(file2, "begin writeln(42); end.");

      await watcher.scanDirectory();

      assert.equal(receivedJobs.length, 2);
      assert.equal(receivedJobs[1].contestant, "HS01");
      assert.equal(receivedJobs[1].problem, "SUM");
      assert.equal(newContestantFlags[1], false);

      // Verify SUM.pas is at Contestants/HS01/SUM.pas
      const destFile2 = path.join(contestantsDir, "HS01", "SUM.pas");
      assert.equal(fs.existsSync(destFile2), true);

      // Verify old SUM.cpp was moved into Contestants/HS01/$History/
      const historyDir = path.join(contestantsDir, "HS01", "$History");
      assert.equal(fs.existsSync(historyDir), true);
      const archivedFiles = fs.readdirSync(historyDir);
      assert.equal(archivedFiles.length, 1);
      assert.match(archivedFiles[0], /SUM\.cpp$/);

      // 3. Invalid submission: should be moved to OSD/Rejected
      const invalidFile = path.join(osdDir, "random_garbage.cpp");
      fs.writeFileSync(invalidFile, "bad");

      await watcher.scanDirectory();

      assert.equal(receivedJobs.length, 2); // No new job
      const rejectedFile = path.join(osdDir, "Rejected", "random_garbage.cpp");
      assert.equal(fs.existsSync(rejectedFile), true);
      // The web bridge uses lowercase `logs` on case-sensitive hosts too.
      const logFile = path.join(osdDir, "logs", "random_garbage.cpp.log");
      assert.equal(fs.existsSync(logFile), true);
    } finally {
      watcher.stop();
      fs.rmSync(rootTemp, { recursive: true, force: true });
    }
  });

  it("ingests submissions written immediately after start even when FSWatcher misses the startup write", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_osd_startup_"));
    const inbox = path.join(root, "osd");
    const contestants = path.join(root, "contestants");
    const jobs: OsdJob[] = [];
    const watcher = new OsdWatcher({
      osdPath: inbox,
      contestantsPath: contestants,
      getValidProblems: () => ["SUM"],
      onSubmissionIngested: job => jobs.push(job),
      debounceMs: 5,
      pollIntervalMs: 60_000,
    });
    try {
      watcher.start();
      (watcher as unknown as { fsWatcher: fs.FSWatcher | null }).fsWatcher?.close();
      fs.writeFileSync(path.join(inbox, "0[HS01][SUM]cpp"), "// startup race");
      await waitForJobs(jobs, 1);
      assert.equal(jobs[0].contestant, "HS01");
      assert.equal(jobs[0].problem, "SUM");
    } finally {
      watcher.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
