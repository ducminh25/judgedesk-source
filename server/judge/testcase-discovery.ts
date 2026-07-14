import fs from "fs";
import path from "path";

export interface ProblemDirectory {
  name: string;
  path: string;
}

export interface TestCaseFiles {
  name: string;
  directory: string;
  inputPath: string;
  outputPath: string;
  inputFileName: string;
}

export function createProblemDirectoryResolver(testDirectory: string): (problemName: string) => ProblemDirectory | null {
  const entries = fs.readdirSync(testDirectory);
  return problemName => {
    const match = entries.find(entry => entry.toLowerCase() === problemName.toLowerCase());
    return match ? { name: match, path: path.join(testDirectory, match) } : null;
  };
}

export function listTestDirectories(problemDirectory: string): string[] {
  return fs.readdirSync(problemDirectory)
    .filter(name => fs.statSync(path.join(problemDirectory, name)).isDirectory())
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

export function resolveTestCaseFiles(problemDirectory: string, testName: string): TestCaseFiles | null {
  const directory = path.join(problemDirectory, testName);
  const files = fs.readdirSync(directory);
  const inputFileName = files.find(name => name.toLowerCase().endsWith(".inp") || name.toLowerCase().endsWith(".in"));
  const outputFileName = files.find(name => name.toLowerCase().endsWith(".out") || name.toLowerCase().endsWith(".ans"));
  if (!inputFileName || !outputFileName) return null;
  return {
    name: testName,
    directory,
    inputPath: path.join(directory, inputFileName),
    outputPath: path.join(directory, outputFileName),
    inputFileName
  };
}
