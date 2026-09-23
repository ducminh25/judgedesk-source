import type { TestVerdict } from "../types.js";
import {
  isBuiltInCheckerId,
  type BuiltInCheckerId,
  type PolygonCheckerId,
  type ThemisCheckerId,
} from "../../shared/checker-catalog.js";

export type StandardCheckerType = ThemisCheckerId;

export interface StandardCheckerResult {
  status: Extract<TestVerdict, "AC" | "WA" | "PE" | "FAIL">;
  message: string;
}

export function isStandardChecker(
  checkerType: string,
): checkerType is StandardCheckerType {
  return ["C1", "C2", "C3", "C4", "C5"].includes(checkerType);
}

export function isBuiltInChecker(
  checkerType: string,
): checkerType is BuiltInCheckerId {
  return isBuiltInCheckerId(checkerType);
}

export function runStandardChecker(
  checkerType: BuiltInCheckerId,
  expectedOutput: string | Buffer,
  actualOutput: string | Buffer,
): StandardCheckerResult {
  const expBuf = toBuffer(expectedOutput);
  const actBuf = toBuffer(actualOutput);

  if (checkerType === "C1") return compareThemisByLine(expBuf, actBuf, true);
  if (checkerType === "C2") return compareThemisByLine(expBuf, actBuf, false);
  if (checkerType === "C3") return compareThemisWords(expBuf, actBuf, true);
  if (checkerType === "C4") return compareThemisWords(expBuf, actBuf, false);
  if (checkerType === "C5") return compareBinary(expBuf, actBuf);

  const expected = toText(expectedOutput);
  const actual = toText(actualOutput);
  return runPolygonChecker(checkerType, expected, actual);
}

function runPolygonChecker(
  checkerType: PolygonCheckerId,
  expected: string,
  actual: string,
): StandardCheckerResult {
  switch (checkerType) {
    case "polygon:fcmp":
      return comparePolygonLines(expected, actual, false);
    case "polygon:lcmp":
      return comparePolygonLines(expected, actual, true);
    case "polygon:hcmp":
      return compareHugeInteger(expected, actual);
    case "polygon:ncmp":
      return compareInt64Sequence(expected, actual);
    case "polygon:nyesno":
      return compareYesNoSequence(expected, actual);
    case "polygon:rcmp4":
      return compareRealSequence(expected, actual, 1e-4, 5);
    case "polygon:rcmp6":
      return compareRealSequence(expected, actual, 1e-6, 7);
    case "polygon:rcmp9":
      return compareRealSequence(expected, actual, 1e-9, 10);
    case "polygon:wcmp":
      return compareTokenSequence(expected, actual);
    case "polygon:yesno":
      return compareSingleYesNo(expected, actual);
  }
}

function foldAsciiByte(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

function wordsEqual(a: Buffer, b: Buffer, ignoreCase: boolean): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ba = ignoreCase ? foldAsciiByte(a[i]) : a[i];
    const bb = ignoreCase ? foldAsciiByte(b[i]) : b[i];
    if (ba !== bb) return false;
  }
  return true;
}

function parseThemisLines(buf: Buffer): Buffer[][] {
  if (buf.length === 0) return [];

  const lines: Buffer[][] = [];
  let currentWords: Buffer[] = [];
  let wordStart = -1;
  let i = 0;
  let hadEolAtEnd = false;

  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x0d || b === 0x0a) {
      if (wordStart !== -1) {
        currentWords.push(buf.subarray(wordStart, i));
        wordStart = -1;
      }
      lines.push(currentWords);
      currentWords = [];
      hadEolAtEnd = true;
      if (b === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) {
        i += 2;
      } else {
        i += 1;
      }
    } else if (b === 0x20 || b === 0x09) {
      if (wordStart !== -1) {
        currentWords.push(buf.subarray(wordStart, i));
        wordStart = -1;
      }
      hadEolAtEnd = false;
      i += 1;
    } else {
      if (wordStart === -1) {
        wordStart = i;
      }
      hadEolAtEnd = false;
      i += 1;
    }
  }

  if (wordStart !== -1) {
    currentWords.push(buf.subarray(wordStart, buf.length));
  }
  if (!hadEolAtEnd || currentWords.length > 0) {
    lines.push(currentWords);
  }

  return lines;
}

function trimThemisTrailingBlankLines(lines: Buffer[][]): Buffer[][] {
  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines;
}

function compareThemisByLine(
  expectedOutput: Buffer,
  actualOutput: Buffer,
  ignoreCase: boolean,
): StandardCheckerResult {
  const expectedLines = trimThemisTrailingBlankLines(parseThemisLines(expectedOutput));
  const actualLines = trimThemisTrailingBlankLines(parseThemisLines(actualOutput));
  const lineCount = Math.max(expectedLines.length, actualLines.length);

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const expWords = expectedLines[lineIndex] || [];
    const actWords = actualLines[lineIndex] || [];

    if (expWords.length !== actWords.length) {
      return { status: "WA", message: `Wrong answer at line ${lineIndex + 1}` };
    }

    for (let wordIndex = 0; wordIndex < expWords.length; wordIndex++) {
      if (!wordsEqual(expWords[wordIndex], actWords[wordIndex], ignoreCase)) {
        return { status: "WA", message: `Wrong answer at line ${lineIndex + 1}` };
      }
    }
  }

  return {
    status: "AC",
    message: expectedLines.length === 1 ? "single line" : `${expectedLines.length} lines`,
  };
}

function parseThemisWords(buf: Buffer): Buffer[] {
  const words: Buffer[] = [];
  let wordStart = -1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) {
      if (wordStart !== -1) {
        words.push(buf.subarray(wordStart, i));
        wordStart = -1;
      }
    } else {
      if (wordStart === -1) {
        wordStart = i;
      }
    }
  }
  if (wordStart !== -1) {
    words.push(buf.subarray(wordStart, buf.length));
  }
  return words;
}

function compareThemisWords(
  expectedOutput: Buffer,
  actualOutput: Buffer,
  ignoreCase: boolean,
): StandardCheckerResult {
  const expectedWords = parseThemisWords(expectedOutput);
  const actualWords = parseThemisWords(actualOutput);
  const minLen = Math.min(expectedWords.length, actualWords.length);

  for (let wordIndex = 0; wordIndex < minLen; wordIndex++) {
    if (!wordsEqual(expectedWords[wordIndex], actualWords[wordIndex], ignoreCase)) {
      return { status: "WA", message: `Wrong answer at word ${wordIndex + 1}` };
    }
  }

  if (expectedWords.length !== actualWords.length) {
    return {
      status: "WA",
      message: `Wrong answer: different number of words (expected ${expectedWords.length}, found ${actualWords.length})`,
    };
  }

  return {
    status: "AC",
    message: expectedWords.length === 1 ? "single word" : `${expectedWords.length} words`,
  };
}

function compareBinary(
  expectedOutput: string | Buffer,
  actualOutput: string | Buffer,
): StandardCheckerResult {
  const expected = toBuffer(expectedOutput);
  const actual = toBuffer(actualOutput);
  const length = Math.min(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (expected[index] !== actual[index]) {
      return {
        status: "WA",
        message: [
          `Wrong answer at byte ${index + 1}`,
          `expected 0x${hexByte(expected[index])}`,
          `found 0x${hexByte(actual[index])}`,
          `expected preview ${hexPreview(expected, index)}`,
          `actual preview ${hexPreview(actual, index)}`,
        ].join("; "),
      };
    }
  }
  if (expected.length !== actual.length) {
    return {
      status: "WA",
      message: [
        `Wrong answer: different file length (expected ${expected.length}, found ${actual.length})`,
        `expected preview ${hexPreview(expected, length)}`,
        `actual preview ${hexPreview(actual, length)}`,
      ].join("; "),
    };
  }
  return { status: "AC", message: `files are identical (${expected.length} bytes)` };
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function hexPreview(value: Buffer, center: number): string {
  const start = Math.max(0, center - 8);
  const end = Math.min(value.length, center + 9);
  const body = Array.from(value.subarray(start, end), hexByte).join(" ");
  return `[${start}..${Math.max(start, end - 1)}] ${body || "<empty>"}`;
}

function comparePolygonLines(
  expected: string,
  actual: string,
  tokenized: boolean,
): StandardCheckerResult {
  const expectedLines = polygonLines(expected);
  const actualLines = polygonLines(actual);
  let lastActual = "";
  for (let index = 0; index < expectedLines.length; index += 1) {
    const expectedLine = expectedLines[index];
    const actualLine = actualLines[index];
    lastActual = actualLine ?? "";
    const equal =
      actualLine !== undefined &&
      (tokenized
        ? arraysEqual(splitAllWords(expectedLine, false), splitAllWords(actualLine, false))
        : expectedLine === actualLine);
    if (!equal) {
      return {
        status: "WA",
        message: `${index + 1}${englishEnding(index + 1)} lines differ - expected: '${compress(expectedLine)}', found: '${compress(actualLine ?? "")}'`,
      };
    }
  }
  return expectedLines.length === 1
    ? { status: "AC", message: `single line: '${compress(lastActual)}'` }
    : { status: "AC", message: `${expectedLines.length} lines` };
}

function compareHugeInteger(expected: string, actual: string): StandardCheckerResult {
  const expectedTokens = splitAllWords(expected, false);
  const expectedToken = expectedTokens[0] || "";
  const actualToken = splitAllWords(actual, false)[0] || "";
  const normalizedExpected = normalizeHugeInteger(expectedToken);
  const normalizedActual = normalizeHugeInteger(actualToken);
  if (!normalizedExpected)
    return { status: "FAIL", message: `${compress(expectedToken)} is not a valid integer` };
  if (expectedTokens.length !== 1)
    return { status: "FAIL", message: "expected exactly one token in the answer file" };
  if (!normalizedActual)
    return { status: "PE", message: `${compress(actualToken)} is not a valid integer` };
  return normalizedExpected === normalizedActual
    ? { status: "AC", message: `answer is '${compress(normalizedExpected)}'` }
    : {
        status: "WA",
        message: `expected '${compress(normalizedExpected)}', found '${compress(normalizedActual)}'`,
      };
}

function compareInt64Sequence(expected: string, actual: string): StandardCheckerResult {
  const expectedTokens = splitAllWords(expected, false);
  const actualTokens = splitAllWords(actual, false);
  const commonLength = Math.min(expectedTokens.length, actualTokens.length);
  const firstValues: string[] = [];
  for (let index = 0; index < commonLength; index += 1) {
    const expectedValue = parseInt64(expectedTokens[index]);
    const actualValue = parseInt64(actualTokens[index]);
    if (expectedValue === null)
      return { status: "FAIL", message: `Invalid int64 in answer at token ${index + 1}` };
    if (actualValue === null)
      return { status: "PE", message: `Invalid int64 in output at token ${index + 1}` };
    if (expectedValue !== actualValue) {
      return {
        status: "WA",
        message: `${index + 1}${englishEnding(index + 1)} numbers differ - expected: '${expectedValue}', found: '${actualValue}'`,
      };
    }
    if (index < 5) firstValues.push(expectedValue.toString());
  }
  for (let index = commonLength; index < expectedTokens.length; index += 1) {
    if (parseInt64(expectedTokens[index]) === null)
      return { status: "FAIL", message: `Invalid int64 in answer at token ${index + 1}` };
  }
  for (let index = commonLength; index < actualTokens.length; index += 1) {
    if (parseInt64(actualTokens[index]) === null)
      return { status: "PE", message: `Invalid int64 in output at token ${index + 1}` };
  }
  if (expectedTokens.length > actualTokens.length)
    return {
      status: "WA",
      message: `Answer contains longer sequence [length = ${expectedTokens.length}], but output contains ${actualTokens.length} elements`,
    };
  if (actualTokens.length > expectedTokens.length)
    return {
      status: "WA",
      message: `Output contains longer sequence [length = ${actualTokens.length}], but answer contains ${expectedTokens.length} elements`,
    };
  return expectedTokens.length <= 5
    ? { status: "AC", message: `${expectedTokens.length} number(s): "${firstValues.join(" ")}"` }
    : { status: "AC", message: `${expectedTokens.length} numbers` };
}

function compareYesNoSequence(expected: string, actual: string): StandardCheckerResult {
  const expectedTokens = splitAllWords(expected, true).map((token) => token.toUpperCase());
  const actualTokens = splitAllWords(actual, true).map((token) => token.toUpperCase());
  const commonLength = Math.min(expectedTokens.length, actualTokens.length);
  let yesCount = 0;
  let noCount = 0;
  for (let index = 0; index < commonLength; index += 1) {
    const expectedToken = expectedTokens[index];
    const actualToken = actualTokens[index];
    if (!isYesNo(expectedToken))
      return { status: "FAIL", message: `YES or NO expected in answer, but ${compress(expectedToken)} found [${index + 1}${englishEnding(index + 1)} token]` };
    if (!isYesNo(actualToken))
      return { status: "PE", message: `YES or NO expected, but ${compress(actualToken)} found [${index + 1}${englishEnding(index + 1)} token]` };
    if (actualToken === "YES") yesCount += 1;
    else noCount += 1;
    if (expectedToken !== actualToken)
      return { status: "WA", message: `expected ${expectedToken}, found ${actualToken} [${index + 1}${englishEnding(index + 1)} token]` };
  }
  if (expectedTokens.length !== actualTokens.length) {
    const outputLonger = actualTokens.length > expectedTokens.length;
    return {
      status: "WA",
      message: outputLonger
        ? `Output contains longer sequence [length = ${actualTokens.length}], but answer contains ${expectedTokens.length} elements`
        : `Answer contains longer sequence [length = ${expectedTokens.length}], but output contains ${actualTokens.length} elements`,
    };
  }
  if (expectedTokens.length === 0) return { status: "AC", message: "Empty output" };
  if (expectedTokens.length === 1) return { status: "AC", message: actualTokens[0] };
  return {
    status: "AC",
    message: `${expectedTokens.length} token(s): yes count is ${yesCount}, no count is ${noCount}`,
  };
}

function compareSingleYesNo(expected: string, actual: string): StandardCheckerResult {
  const expectedToken = (splitAllWords(expected, false)[0] || "").toUpperCase();
  const actualToken = (splitAllWords(actual, false)[0] || "").toUpperCase();
  if (!isYesNo(expectedToken))
    return { status: "FAIL", message: `YES or NO expected in answer, but ${compress(expectedToken)} found` };
  if (!isYesNo(actualToken))
    return { status: "PE", message: `YES or NO expected, but ${compress(actualToken)} found` };
  if (expectedToken !== actualToken)
    return { status: "WA", message: `expected ${expectedToken}, found ${actualToken}` };
  return { status: "AC", message: `answer is ${expectedToken}` };
}

function compareRealSequence(
  expected: string,
  actual: string,
  epsilon: number,
  digits: number,
): StandardCheckerResult {
  const expectedTokens = splitAllWords(expected, false);
  const actualTokens = splitAllWords(actual, false);
  let lastExpected = 0;
  let lastActual = 0;
  for (let index = 0; index < expectedTokens.length; index += 1) {
    lastExpected = parseTestlibDouble(expectedTokens[index]);
    lastActual = parseTestlibDouble(actualTokens[index]);
    if (Number.isNaN(lastExpected) && expectedTokens[index].toLowerCase() !== "nan")
      return { status: "FAIL", message: `Invalid real number in answer at token ${index + 1}` };
    if (
      actualTokens[index] === undefined ||
      (Number.isNaN(lastActual) && actualTokens[index].toLowerCase() !== "nan")
    )
      return { status: "PE", message: `Invalid real number in output at token ${index + 1}` };
    if (!doubleCompare(lastExpected, lastActual, epsilon)) {
      return {
        status: "WA",
        message: `${index + 1}${englishEnding(index + 1)} numbers differ - expected: '${lastExpected.toFixed(digits)}', found: '${lastActual.toFixed(digits)}', error = '${doubleDelta(lastExpected, lastActual).toFixed(digits)}'`,
      };
    }
  }
  return expectedTokens.length === 1
    ? {
        status: "AC",
        message: `found '${lastActual.toFixed(digits)}', expected '${lastExpected.toFixed(digits)}', error '${doubleDelta(lastExpected, lastActual).toFixed(digits)}'`,
      }
    : { status: "AC", message: `${expectedTokens.length} numbers` };
}

function compareTokenSequence(expected: string, actual: string): StandardCheckerResult {
  const expectedTokens = splitAllWords(expected, false);
  const actualTokens = splitAllWords(actual, false);
  const commonLength = Math.min(expectedTokens.length, actualTokens.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (expectedTokens[index] !== actualTokens[index]) {
      return {
        status: "WA",
        message: `${index + 1}${englishEnding(index + 1)} words differ - expected: '${compress(expectedTokens[index])}', found: '${compress(actualTokens[index])}'`,
      };
    }
  }
  if (actualTokens.length > expectedTokens.length)
    return { status: "WA", message: "Participant output contains extra tokens" };
  if (expectedTokens.length > actualTokens.length)
    return { status: "WA", message: "Unexpected EOF in the participants output" };
  return expectedTokens.length === 1
    ? { status: "AC", message: `"${compress(expectedTokens[0])}"` }
    : { status: "AC", message: `${expectedTokens.length} tokens` };
}

function normalizeHugeInteger(value: string): string | null {
  return /^(?:0|-?[1-9]\d*)$/.test(value) ? value : null;
}

function parseInt64(value: string): bigint | null {
  if (!/^[+-]?\d+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= -(2n ** 63n) && parsed <= 2n ** 63n - 1n ? parsed : null;
  } catch {
    return null;
  }
}

function doubleCompare(expected: number, actual: number, epsilon: number): boolean {
  epsilon += 1e-15;
  if (Number.isNaN(expected)) return Number.isNaN(actual);
  if (!Number.isFinite(expected)) return expected === actual;
  if (!Number.isFinite(actual)) return false;
  const difference = Math.abs(expected - actual);
  return difference <= epsilon || difference <= Math.abs(expected) * epsilon;
}

function doubleDelta(expected: number, actual: number): number {
  const difference = Math.abs(expected - actual);
  return Math.abs(expected) > 1e-9
    ? Math.min(difference, Math.abs(difference / expected))
    : difference;
}

function parseTestlibDouble(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const normalized = value.toLowerCase();
  if (normalized === "nan") return Number.NaN;
  if (normalized === "inf" || normalized === "+inf" || normalized === "infinity" || normalized === "+infinity")
    return Number.POSITIVE_INFINITY;
  if (normalized === "-inf" || normalized === "-infinity")
    return Number.NEGATIVE_INFINITY;
  return Number(value);
}

function isYesNo(value: string): boolean {
  return value === "YES" || value === "NO";
}

function polygonLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  // fcmp/lcmp deliberately ignore the final empty line read at EOF, matching
  // the upstream `j.empty() && ans.eof()` behavior.
  if (lines.at(-1) === "") lines.pop();
  return lines;
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

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function englishEnding(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return "th";
  if (value % 10 === 1) return "st";
  if (value % 10 === 2) return "nd";
  if (value % 10 === 3) return "rd";
  return "th";
}

function compress(value: string): string {
  return value.length > 128 ? `${value.slice(0, 125)}...` : value;
}

function toText(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function toBuffer(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}
