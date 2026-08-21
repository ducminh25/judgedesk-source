import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OsdWatcher } from "./osd-watcher.js";
import type { OsdJob } from "./osd-types.js";

describe("osd-watcher", () => {
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
      const logFile = path.join(osdDir, "Logs", "random_garbage.cpp.log");
      assert.equal(fs.existsSync(logFile), true);
    } finally {
      watcher.stop();
      fs.rmSync(rootTemp, { recursive: true, force: true });
    }
  });
});
