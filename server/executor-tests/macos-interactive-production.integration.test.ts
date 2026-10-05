import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const LOG_LIMIT = 8 * 1024 * 1024;
const TAIL_LIMIT = 64 * 1024;

// This opt-in suite needs a separately audited, provisioned private package copy.
// An opted-in missing runtime is a failed required row, never a skipped row.
if (process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_GATE === "1") {
  const selection = process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_CASES;
  test(`macOS production interactive language, source, verdict and award matrix${selection ? ` (focused: ${selection})` : " (full: 91 rows)"}`, { timeout: 900_000 }, async (t) => {
    assert.equal(process.platform, "darwin");
    assert.equal(process.arch, "arm64");
    const suppliedRoot = process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_ROOT;
    assert.ok(suppliedRoot, "provide an audited private JUDGEDESK_INTERACTIVE_PRODUCTION_ROOT");
    const root = fs.realpathSync(suppliedRoot);
    assert.equal(root, path.resolve(suppliedRoot), "private root must already be canonical");
    assert.ok(fs.lstatSync(root).isDirectory());
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    for (const directory of ["appdata", "builtin-toolchains"]) {
      const location = path.join(root, directory);
      assert.ok(fs.lstatSync(location).isDirectory(), `provision ${location} before the gate`);
      assert.equal(fs.realpathSync(location), location);
    }
    assert.ok(process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_LOCAL_PYTHON,
      "provide the selected local Python executable for its required strict-local rows");
    const runRoot = fs.mkdtempSync(path.join(root, "production-run-"));
    const tmp = path.join(runRoot, "tmp");
    fs.mkdirSync(tmp, { mode: 0o700 });
    const generation = crypto.randomBytes(32).toString("hex");
    const generationPath = path.join(runRoot, "process-tree.generation");
    const eventLog = path.join(runRoot, "events.jsonl");
    fs.writeFileSync(generationPath, `JUDGEDESK_PROCESS_TREE/1\ngeneration=${generation}\n`, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(eventLog, "", { flag: "wx", mode: 0o600 });
    const environment = {
      ...process.env,
      TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      THEMIS_APP_DATA_DIR: path.join(root, "appdata"),
      JUDGEDESK_BUILTIN_TOOLCHAINS_DIR: path.join(root, "builtin-toolchains"),
      JUDGEDESK_TREE_GUARD_REQUIRED: "1",
      JUDGEDESK_TREE_GUARD_PATH: generationPath,
      JUDGEDESK_TREE_GUARD_GENERATION: generation,
      JUDGEDESK_RUN_GUARDIAN_FAULT_GATE: "1",
      JUDGEDESK_RUN_GUARDIAN_EVENT_LOG: eventLog,
      JUDGEDESK_INTERACTIVE_PRODUCTION_RUN_ROOT: runRoot,
      JUDGEDESK_INTERACTIVE_FAULT_PAUSE: undefined,
    };
    const worker = spawn(process.execPath, [
      "--import", "tsx", "--test", "--test-isolation=none",
      "--test-name-pattern=macOS production interactive worker",
      path.join(process.cwd(), "server", "executor-tests", "macos-interactive-production.worker.ts"),
    ], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const outputPath = path.join(runRoot, "worker.stdout.log");
    const errorPath = path.join(runRoot, "worker.stderr.log");
    let loggingError: Error | undefined;
    let forcedStop = false;
    let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    const stopWorker = () => {
      worker.kill("SIGTERM");
      stopDeadline ??= setTimeout(() => {
        forcedStop = true;
        worker.kill("SIGKILL");
      }, 30_000);
    };
    const log = (channel: "stdout" | "stderr", destination: string) => {
      const input = worker[channel];
      const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
      let tail = Buffer.alloc(0);
      let bytesWritten = 0;
      let failed = false;
      let resolveFinished: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
      const fail = (error: Error) => {
        failed = true;
        loggingError ??= new Error(`${destination}: ${error.message}`);
        stopWorker();
      };
      output.once("error", fail);
      output.once("close", () => { resolveFinished?.(); });
      input.on("data", (bytes: Buffer) => {
        tail = Buffer.concat([tail, bytes]).subarray(-TAIL_LIMIT);
        if (failed) return;
        if (bytesWritten + bytes.length > LOG_LIMIT) {
          fail(new Error(`owned worker log exceeded ${LOG_LIMIT} bytes`));
          output.end();
          return;
        }
        bytesWritten += bytes.length;
        if (!output.write(bytes)) {
          input.pause();
          output.once("drain", () => { input.resume(); });
        }
      });
      input.once("end", () => { output.end(); });
      input.once("close", () => { if (!output.writableEnded) output.end(); });
      input.once("error", fail);
      // A failed writable must not leave the child's output pipe paused.
      output.once("error", () => { input.resume(); });
      return { finished, tail: () => tail.toString("utf8") };
    };
    const stdout = log("stdout", outputPath);
    const stderr = log("stderr", errorPath);
    const completed = new Promise<number | null>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", (code) => { clearTimeout(stopDeadline); resolve(code); });
    });
    const onAbort = () => {
      // Only the actual spawned worker is signaled. Its handler asks its actual
      // singleton executor to drain; no traced PID/PGID is signal authority.
      stopWorker();
    };
    t.signal.addEventListener("abort", onAbort, { once: true });
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null) stopWorker();
      let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([completed, new Promise<never>((_, reject) => {
          cleanupDeadline = setTimeout(() => reject(new Error(`Owned worker did not close; drain unproved; evidence retained at ${runRoot}`)), 40_000);
        })]);
      } finally { clearTimeout(cleanupDeadline); clearTimeout(stopDeadline); }
      await Promise.all([stdout.finished, stderr.finished]);
    });
    try {
      const code = await completed;
      await Promise.all([stdout.finished, stderr.finished]);
      t.diagnostic(`private evidence retained at ${runRoot}\n${stdout.tail()}\n${stderr.tail()}`);
      if (loggingError) throw loggingError;
      assert.equal(forcedStop, false, `forced worker stop; drain unproved; evidence retained at ${runRoot}`);
      assert.equal(worker.signalCode, null, `worker signal=${worker.signalCode}; ${stderr.tail()}`);
      assert.equal(code, 0, `production matrix failed; ${outputPath}; ${errorPath}\n${stdout.tail()}\n${stderr.tail()}`);
      const receipt = JSON.parse(fs.readFileSync(path.join(runRoot, "completed-rows.json"), "utf8")) as {
        selectedCases: string | null; rows: string[]; cleanupProved: boolean;
      };
      assert.equal(receipt.selectedCases, selection ?? null);
      assert.equal(receipt.cleanupProved, true);
      assert.equal(new Set(receipt.rows).size, receipt.rows.length);
      if (selection === undefined) assert.equal(receipt.rows.length, 91, "required full matrix row count including canonical quota verdicts");
      t.diagnostic(JSON.stringify({ completedRows: receipt.rows.length, selectedCases: receipt.selectedCases }));
    } finally {
      t.signal.removeEventListener("abort", onAbort);
      // The externally provisioned package copy and all failed runtime evidence
      // are deliberately preserved. This suite never performs group recovery.
      t.diagnostic(`retained private runtime: ${runRoot}`);
    }
  });
}
