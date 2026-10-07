import fs from "node:fs";
import path from "node:path";
import { discoverTestCases } from "../judge/testcase-discovery.js";
import type { WellFormedCode, WellFormedIssue, ProblemWellFormedIssue, TestInputValidationResult } from "../../shared/contracts.js";
export type { WellFormedCode, WellFormedIssue, ProblemWellFormedIssue, TestInputValidationResult } from "../../shared/contracts.js";

/** Read actual bytes in bounded chunks. Never repair or rewrite a contestant input. */
export async function validateTestInputFile(inputPath: string): Promise<WellFormedIssue[]> {
  const issues: WellFormedIssue[] = [];
  let line = 1;
  let column = 1;
  let lineLength = 0;
  let previousSpace = false;
  let lastSpaceColumn = 0;
  let pendingCR = false;
  let totalCharacters = 0;
  let lastCompletedLineEmpty = 0;
  let lastWasEol = false;

  const report = (code: WellFormedCode, atLine = line, atColumn = column) => {
    if (issues.length < 200) issues.push({ code, line: atLine, column: atColumn });
  };
  const completeLine = () => {
    if (lastSpaceColumn && lastSpaceColumn !== 1) report("edge_space", line, lastSpaceColumn);
    if (lineLength === 0) {
      if (line === 1) report("edge_empty_line", line, 1);
      lastCompletedLineEmpty = line;
    } else {
      lastCompletedLineEmpty = 0;
    }
    ++line;
    column = 1;
    lineLength = 0;
    previousSpace = false;
    lastSpaceColumn = 0;
    lastWasEol = true;
  };
  const accept = (byte: number) => {
    if (pendingCR) {
      pendingCR = false;
      if (byte === 10) {
        completeLine();
        return;
      }
      report("control_character", line, column);
      ++lineLength;
      ++column;
    }
    if (byte === 13) {
      pendingCR = true;
      lastWasEol = false;
      return;
    }
    if (byte === 10) {
      completeLine();
      return;
    }
    if (byte < 32) report("control_character");
    if (byte === 32) {
      if (lineLength === 0) report("edge_space");
      if (previousSpace) report("consecutive_spaces");
      lastSpaceColumn = column;
      previousSpace = true;
    } else {
      lastSpaceColumn = 0;
      previousSpace = false;
    }
    ++lineLength;
    ++column;
    lastWasEol = false;
  };
  for await (const chunk of fs.createReadStream(inputPath, { highWaterMark: 64 * 1024 })) {
    for (const byte of chunk) {
      ++totalCharacters;
      accept(byte);
    }
  }
  if (pendingCR) {
    report("control_character", line, column);
    ++column;
    lastWasEol = false;
  }
  if (totalCharacters === 0) return [{ code: "empty", line: 1, column: 1 }];
  if (lastCompletedLineEmpty) report("edge_empty_line", lastCompletedLineEmpty, 1);
  if (!lastWasEol) report("missing_eol", line, column);
  return issues;
}

export async function validateProblemTestInputs(
  problemDirectory: string,
  isInteractive = false,
): Promise<TestInputValidationResult> {
  const discovered = discoverTestCases(problemDirectory, isInteractive);
  const issues: ProblemWellFormedIssue[] = [];
  for (const testcase of discovered) {
    const inputIssues = await validateTestInputFile(testcase.inputPath);
    for (const issue of inputIssues) {
      issues.push({ ...issue, testName: testcase.name, fileName: path.basename(testcase.inputPath) });
    }
  }
  return { tests: discovered.length, issues };
}
