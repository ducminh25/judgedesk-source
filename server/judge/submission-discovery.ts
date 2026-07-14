import fs from "fs";
import path from "path";
import type { SubmissionLanguage } from "../types.js";

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
  return contestants.filter(name => targets.includes(name));
}

export function findSubmission(contestantDirectory: string, targetProblem: string): Submission | null {
  const fileName = fs.readdirSync(contestantDirectory).find(name => {
    const filePath = path.join(contestantDirectory, name);
    const extension = path.extname(name);
    const baseName = name.slice(0, name.length - extension.length);
    return fs.statSync(filePath).isFile()
      && baseName.toLowerCase() === targetProblem.toLowerCase()
      && (extension.toLowerCase() === ".cpp" || extension.toLowerCase() === ".py");
  });
  if (!fileName) return null;
  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  return {
    fileName,
    filePath: path.join(contestantDirectory, fileName),
    problemName: baseName,
    language: extension.toLowerCase() === ".cpp" ? "cpp" : "python"
  };
}
