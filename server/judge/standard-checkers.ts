export type StandardCheckerType = "C1" | "C2" | "C3" | "C4" | "C5";

export interface StandardCheckerResult {
  status: "AC" | "WA";
  message: string;
}

const STANDARD_CHECKERS = new Set<StandardCheckerType>(["C1", "C2", "C3", "C4", "C5"]);

export function isStandardChecker(checkerType: string): checkerType is StandardCheckerType {
  return STANDARD_CHECKERS.has(checkerType as StandardCheckerType);
}

export function runStandardChecker(
  checkerType: StandardCheckerType,
  expectedOutput: string,
  actualOutput: string
): StandardCheckerResult {
  if (checkerType === "C1") {
    return compareByLine(expectedOutput, actualOutput, true);
  }
  if (checkerType === "C2") {
    return compareByLine(expectedOutput, actualOutput, false);
  }
  if (checkerType === "C3") {
    return compareWords(expectedOutput, actualOutput, true);
  }
  if (checkerType === "C4") {
    return compareWords(expectedOutput, actualOutput, false);
  }

  return expectedOutput === actualOutput
    ? { status: "AC", message: "ok" }
    : { status: "WA", message: "Files are not identical" };
}

function compareByLine(expectedOutput: string, actualOutput: string, ignoreCase: boolean): StandardCheckerResult {
  const expectedLines = trimTrailingBlankLines(expectedOutput.split(/\r?\n/));
  const actualLines = trimTrailingBlankLines(actualOutput.split(/\r?\n/));
  const lineCount = Math.max(expectedLines.length, actualLines.length);

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const expectedWords = splitLineWords(expectedLines[lineIndex] || "", ignoreCase);
    const actualWords = splitLineWords(actualLines[lineIndex] || "", ignoreCase);
    if (
      expectedWords.length !== actualWords.length ||
      !expectedWords.every((word, wordIndex) => word === actualWords[wordIndex])
    ) {
      return { status: "WA", message: `Wrong answer at line ${lineIndex + 1}` };
    }
  }

  return { status: "AC", message: "ok" };
}

function compareWords(expectedOutput: string, actualOutput: string, ignoreCase: boolean): StandardCheckerResult {
  const expectedWords = splitAllWords(expectedOutput, ignoreCase);
  const actualWords = splitAllWords(actualOutput, ignoreCase);
  if (expectedWords.length !== actualWords.length) {
    return {
      status: "WA",
      message: `Wrong answer: different number of words (expected ${expectedWords.length}, found ${actualWords.length})`
    };
  }

  for (let wordIndex = 0; wordIndex < expectedWords.length; wordIndex += 1) {
    if (expectedWords[wordIndex] !== actualWords[wordIndex]) {
      return { status: "WA", message: `Wrong answer at word ${wordIndex + 1}` };
    }
  }
  return { status: "AC", message: "ok" };
}

function trimTrailingBlankLines(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

function splitLineWords(line: string, ignoreCase: boolean): string[] {
  return line
    .split(/[ \t]+/)
    .map((word) => (ignoreCase ? word.toLowerCase() : word))
    .filter(Boolean);
}

function splitAllWords(text: string, ignoreCase: boolean): string[] {
  return text
    .split(/\s+/)
    .map((word) => (ignoreCase ? word.toLowerCase() : word))
    .filter(Boolean);
}
