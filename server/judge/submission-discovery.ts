import fs from "fs";
import path from "path";
import type { SubmissionLanguage } from "../types.js";
import { isIgnoredOsMetadataName } from "../file-utils.js";
import { getRegisteredProfileForExtension } from "../languages/registry.js";

export interface Submission {
  fileName: string;
  filePath: string;
  problemName: string;
  language: SubmissionLanguage;
}

export type SubmissionResolver = (targetProblem: string) => Submission | null;

export function listContestants(contestantsDirectory: string, targets?: unknown): string[] {
  const contestants = fs.readdirSync(contestantsDirectory)
    .filter(name => !isIgnoredOsMetadataName(name) && fs.statSync(path.join(contestantsDirectory, name)).isDirectory());
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
  return createSubmissionResolver(contestantDirectory)(targetProblem);
}

export function createSubmissionResolver(contestantDirectory: string): SubmissionResolver {
  const candidatesByProblem = new Map<string, Submission[]>();
  for (const entry of fs.readdirSync(contestantDirectory, { withFileTypes: true })) {
    const name = entry.name;
    if (isIgnoredOsMetadataName(name)) continue;
    const filePath = path.join(contestantDirectory, name);
    const extension = path.extname(name);
    const baseName = name.slice(0, name.length - extension.length);
    const registered = getRegisteredProfileForExtension(extension);
    const isFile = entry.isFile()
      || (entry.isSymbolicLink() && fs.statSync(filePath).isFile());
    if (!registered || !isFile) continue;
    const normalizedProblem = baseName.toLowerCase();
    const submissions = candidatesByProblem.get(normalizedProblem) ?? [];
    submissions.push({
      fileName: name,
      filePath,
      problemName: baseName,
      language: registered.toolchainKind as SubmissionLanguage,
    });
    candidatesByProblem.set(normalizedProblem, submissions);
  }

  return targetProblem => {
    const candidates = candidatesByProblem.get(targetProblem.toLowerCase()) ?? [];
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      throw new Error(
        `AMBIGUOUS_SUBMISSION: '${targetProblem}' has multiple supported source files: ${
          candidates.map(candidate => candidate.fileName)
            .sort((left, right) => left.localeCompare(right))
            .join(", ")
        }`,
      );
    }
    return candidates[0];
  };
}
