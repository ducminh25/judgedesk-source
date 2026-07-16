import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSubmission } from "../server/judge/compiler.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "themis-compile-bomb-"));
try {
  const result = await compileSubmission({
    language: "cpp",
    contestantName: "Limit",
    problemName: "Bomb",
    submissionPath: path.resolve("scripts/fixtures/compiler-output-bomb.cpp"),
    tempDirectory: workspace,
  });
  if (
    result.compileStatus !== "CE" ||
    result.compileError !== "GENERATED_FILE_TOO_LARGE"
  ) {
    throw new Error(`Unexpected compiler-limit result: ${JSON.stringify(result)}`);
  }
  console.log(
    `Compiler output-limit smoke test passed in ${result.compileTime.toFixed(0)} ms: ${result.compileError}`,
  );
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
