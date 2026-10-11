import { getRegisteredProfileForExtension } from "../languages/registry.js";
import type { SubmissionLanguage } from "../types.js";
import type { OsdParsedSubmission } from "./osd-types.js";

// Themis web writes 0[Contestant][Problem]ext; dotted OSD names also remain valid.
// Examples:
// - [HS01][BAI1].cpp
// - 001[LeVanA][SUM].pas
// - 20260821_143000[Mon][PROB1].py
const THEMIS_OSD_REGEX = /^([^\[\]]*)\[([^\[\]]+)\]\[([^\[\]]+)\]\.?(\w+)$/;

export function isSafeOsdComponent(value: string): boolean {
  return value.length > 0 && value.length <= 255
    && value.trim() === value && !/[. ]$/.test(value)
    && value !== "." && value !== ".."
    && !/[\x00-\x1F\x7F\\/:*?"<>|‣]/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

export function sanitizeContestantName(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // Strip null bytes and control characters
  const clean = trimmed.replace(/[\x00-\x1F\x7F]/g, "");
  // Replace illegal file system characters and path traversal segments with underscores
  let sanitized = clean
    .replace(/[\\/:\*\?"<>\|]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[\.\s_]+|[\.\s_]+$/g, "")
    .trim();
  return sanitized;
}

export function sanitizeProblemName(raw: string): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[\\/:\*\?"<>\|]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[\.\s_]+|[\.\s_]+$/g, "")
    .trim();
}

export function parseOsdFileName(
  fileName: string,
  validProblemNames?: Iterable<string>,
): OsdParsedSubmission {
  const match = fileName.match(THEMIS_OSD_REGEX);

  if (!match || fileName.trim() !== fileName || fileName.length > 240
    || /[\x00-\x1F\x7F]/.test(fileName)
    || /[\\/:*?"<>|]/.test(match[1])) {
    return {
      originalFileName: fileName,
      contestant: "",
      problem: "",
      extension: "",
      language: "cpp",
      valid: false,
      errorReason: "INVALID_FILENAME_FORMAT: Expected *[Contestant][Problem]ext or *[Contestant][Problem].ext",
    };
  }

  const [, , rawContestant, rawProblem, rawExt] = match;
  const contestant = rawContestant;
  const problemCandidate = rawProblem;
  const extension = rawExt.toLowerCase();

  if (!isSafeOsdComponent(contestant)) {
    return {
      originalFileName: fileName,
      contestant: "",
      problem: problemCandidate,
      extension,
      language: "cpp",
      valid: false,
      errorReason: "INVALID_CONTESTANT_NAME: Contestant name contains only invalid or empty characters",
    };
  }

  if (!isSafeOsdComponent(problemCandidate)) {
    return {
      originalFileName: fileName,
      contestant,
      problem: "",
      extension,
      language: "cpp",
      valid: false,
      errorReason: "INVALID_PROBLEM_NAME: Problem name contains only invalid or empty characters",
    };
  }

  const profile = getRegisteredProfileForExtension(`.${extension}`);
  if (!profile) {
    return {
      originalFileName: fileName,
      contestant,
      problem: problemCandidate,
      extension,
      language: "cpp",
      valid: false,
      errorReason: `UNSUPPORTED_LANGUAGE: Extension '.${extension}' is not supported by JudgeDesk`,
    };
  }

  const language = profile.toolchainKind as SubmissionLanguage;

  let resolvedProblem = problemCandidate;
  if (validProblemNames) {
    const candidateLower = problemCandidate.toLowerCase();
    let found = false;
    for (const validName of validProblemNames) {
      if (isSafeOsdComponent(validName) && validName.toLowerCase() === candidateLower) {
        resolvedProblem = validName;
        found = true;
        break;
      }
    }
    if (!found) {
      return {
        originalFileName: fileName,
        contestant,
        problem: problemCandidate,
        extension,
        language,
        valid: false,
        errorReason: `PROBLEM_NOT_FOUND: Problem '${problemCandidate}' does not exist in the active contest`,
      };
    }
  }

  return {
    originalFileName: fileName,
    contestant,
    problem: resolvedProblem,
    extension,
    language,
    valid: true,
  };
}
