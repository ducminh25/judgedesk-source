import fs from "fs";
import path from "path";
import type { SubmissionLanguage } from "../types.js";
import { getRegisteredProfileForExtension } from "../languages/registry.js";

export interface Submission {
  fileName: string;
  filePath: string;
  problemName: string;
  language: SubmissionLanguage;
}

export function listContestants(contestantsDirectory: string, targets?: unknown): string[] {
  const contestants = fs.readdirSync(contestantsDirectory)
    .filter(name => fs.statSync(path.join(contestantsDirectory, name)).isDirectory());
  if (!Array.isArray(targets)) return contestants;
  const available = new Set(contestants);
  const seen = new Set<string>();
  return targets.filter((name): name is string => {
    if (typeof name !== "string" || seen.has(name) || !available.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export function findSubmission(contestantDirectory: string, targetProblem: string): Submission | null {
  const candidates = fs.readdirSync(contestantDirectory).filter(name => {
    const filePath = path.join(contestantDirectory, name);
    const extension = path.extname(name);
    const baseName = name.slice(0, name.length - extension.length);
    return fs.statSync(filePath).isFile()
      && baseName.toLowerCase() === targetProblem.toLowerCase()
      && !!getRegisteredProfileForExtension(extension);
  });
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `AMBIGUOUS_SUBMISSION: '${targetProblem}' has multiple supported source files: ${
        candidates.sort((left, right) => left.localeCompare(right)).join(", ")
      }`,
    );
  }
  const fileName = candidates[0];
  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  const registered = getRegisteredProfileForExtension(extension);
  if (!registered) return null;
  return {
    fileName,
    filePath: path.join(contestantDirectory, fileName),
    problemName: baseName,
    language: registered.toolchainKind as SubmissionLanguage,
  };
}
