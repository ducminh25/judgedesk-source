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
  return fs.readdirSync(problemDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => resolveTestCaseFiles(problemDirectory, name) !== null)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

export function resolveTestCaseFiles(problemDirectory: string, testName: string): TestCaseFiles | null {
  const directory = path.join(problemDirectory, testName);
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const regularFiles = files.filter(entry => entry.isFile()).map(entry => entry.name);
  const inputFileName = regularFiles.find(name => {
    const extension = path.extname(name).toLowerCase();
    return extension === ".inp" || extension === ".in";
  });
  const outputFileName = regularFiles.find(name => {
    const extension = path.extname(name).toLowerCase();
    return extension === ".out" || extension === ".ans";
  });
  if (!inputFileName || !outputFileName) return null;
  return {
    name: testName,
    directory,
    inputPath: path.join(directory, inputFileName),
    outputPath: path.join(directory, outputFileName),
    inputFileName
  };
}
