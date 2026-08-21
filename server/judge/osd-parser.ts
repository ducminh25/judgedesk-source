import { getRegisteredProfileForExtension } from "../languages/registry.js";
import type { SubmissionLanguage } from "../types.js";
import type { OsdParsedSubmission } from "./osd-types.js";

// Standard Themis convention: *[Contestant][Problem].ext
// Examples:
// - [HS01][BAI1].cpp
// - 001[LeVanA][SUM].pas
// - 20260821_143000[Mon][PROB1].py
const THEMIS_OSD_REGEX = /^(?:.*)\[([^\[\]]+)\]\[([^\[\]]+)\]\.([a-zA-Z0-9]+)$/;

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
  const trimmedName = fileName.trim();
  const match = trimmedName.match(THEMIS_OSD_REGEX);

  if (!match) {
    return {
      originalFileName: fileName,
      contestant: "",
      problem: "",
      extension: "",
      language: "cpp",
      valid: false,
      errorReason: "INVALID_FILENAME_FORMAT: File name must match *[Contestant][Problem].ext format",
    };
  }

  const [, rawContestant, rawProblem, rawExt] = match;
  const contestant = sanitizeContestantName(rawContestant);
  const problemCandidate = sanitizeProblemName(rawProblem);
  const extension = rawExt.toLowerCase();

  if (!contestant || /^_+$/.test(contestant)) {
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

  if (!problemCandidate || /^_+$/.test(problemCandidate)) {
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
      if (validName.toLowerCase() === candidateLower) {
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
