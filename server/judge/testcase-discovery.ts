import fs from "fs";
import path from "path";
import { naturalSort } from "../file-utils.js";
import { resolveProblemConfig } from "../problems/problem-config-repository.js";

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

const INPUT_EXTENSIONS = new Set([".inp", ".in"]);
const OUTPUT_EXTENSIONS = new Set([".out", ".ans"]);

export function createProblemDirectoryResolver(testDirectory: string): (problemName: string) => ProblemDirectory | null {
  const entries = fs.readdirSync(testDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const directProblem = isFlatTestDirectory(testDirectory);
  return problemName => {
    if (directProblem && path.basename(testDirectory).toLowerCase() === problemName.toLowerCase()) {
      return { name: path.basename(testDirectory), path: testDirectory };
    }
    const match = entries.find(entry => entry.toLowerCase() === problemName.toLowerCase());
    if (match) {
      return { name: match, path: path.join(testDirectory, match) };
    }
    return null;
  };
}

export function listTestDirectories(problemDirectory: string, isInteractive = false): string[] {
  return discoverTestCases(problemDirectory, isInteractive).map(testCase => testCase.name);
}

function resolveDirectoryTestCaseFiles(
  problemDirectory: string,
  testName: string,
  isInteractive = false,
): TestCaseFiles | null {
  const directory = path.join(problemDirectory, testName);
  let files: fs.Dirent[];
  try {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) return null;
    files = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const regularFiles = files.filter(entry => entry.isFile()).map(entry => entry.name);
  const inputFileName = regularFiles.find(name => {
    const extension = path.extname(name).toLowerCase();
    return INPUT_EXTENSIONS.has(extension);
  });
  const outputFileName = regularFiles.find(name => {
    const extension = path.extname(name).toLowerCase();
    return OUTPUT_EXTENSIONS.has(extension);
  });
  if (!inputFileName) return null;
  if (!isInteractive && !outputFileName) return null;
  return {
    name: testName,
    directory,
    inputPath: path.join(directory, inputFileName),
    outputPath: outputFileName ? path.join(directory, outputFileName) : "",
    inputFileName
  };
}

function discoverFlatTestCases(
  problemDirectory: string,
  entries: fs.Dirent[],
  isInteractive = false,
): TestCaseFiles[] {
  const regularFiles = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort();
  const inputMap = new Map<string, string>();
  const outputMap = new Map<string, string>();

  for (const file of regularFiles) {
    const ext = path.extname(file).toLowerCase();
    const stem = path.parse(file).name;
    const stemLower = stem.toLowerCase();

    if (INPUT_EXTENSIONS.has(ext)) {
      const existing = inputMap.get(stemLower);
      if (!existing || (ext === ".inp" && path.extname(existing).toLowerCase() !== ".inp")) {
        inputMap.set(stemLower, file);
      }
    } else if (OUTPUT_EXTENSIONS.has(ext)) {
      const existing = outputMap.get(stemLower);
      if (!existing || (ext === ".out" && path.extname(existing).toLowerCase() !== ".out")) {
        outputMap.set(stemLower, file);
      }
    }
  }

  const result: TestCaseFiles[] = [];
  for (const [stemLower, inputFileName] of inputMap.entries()) {
    const outputFileName = outputMap.get(stemLower);
    if (!isInteractive && !outputFileName) {
      continue;
    }
    const testName = path.parse(inputFileName).name;
    result.push({
      name: testName,
      directory: problemDirectory,
      inputPath: path.join(problemDirectory, inputFileName),
      outputPath: outputFileName ? path.join(problemDirectory, outputFileName) : "",
      inputFileName,
    });
  }

  return result;
}

export function discoverTestCases(problemDirectory: string, isInteractive = false): TestCaseFiles[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(problemDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const directoryTestCases = entries
    .filter(entry => entry.isDirectory())
    .map(entry => resolveDirectoryTestCaseFiles(problemDirectory, entry.name, isInteractive))
    .filter((testCase): testCase is TestCaseFiles => testCase !== null);

  // Preserve Themis test suites even when sample pairs are left at the problem root.
  const selected = directoryTestCases.length > 0
    ? directoryTestCases
    : discoverFlatTestCases(problemDirectory, entries, isInteractive);

  return selected.sort((left, right) => naturalSort(left.name, right.name)
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export function resolveTestCaseFiles(
  problemDirectory: string,
  testName: string,
  isInteractive = false,
): TestCaseFiles | null {
  return discoverTestCases(problemDirectory, isInteractive)
    .find(files => files.name.toLowerCase() === testName.toLowerCase()) ?? null;
}

export function isFlatTestDirectory(directory: string): boolean {
  const hasFlatTests = discoverTestCases(directory).some(files => files.directory === directory)
    || discoverTestCases(directory, true).some(files => files.directory === directory);
  if (!hasFlatTests) return false;

  // A container can have root samples alongside real problem directories.
  return !fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .some(entry => {
      const child = path.join(directory, entry.name);
      const sameName = entry.name.toLowerCase() === path.basename(directory).toLowerCase();
      const tests = discoverTestCases(child, sameName || resolveProblemConfig(entry.name, child).isInteractive);
      return tests.some(files => files.directory !== child) || (sameName && tests.length > 0);
    });
}

export function resolveProblemDirectoryPath(directory: string): string {
  const resolved = path.resolve(directory);
  try {
    const entry = fs.lstatSync(resolved);
    if (!entry.isDirectory() && !entry.isFile()) return resolved;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = path.dirname(resolved);
  // The editor appends the problem name even when the selected folder is that problem.
  if (path.basename(resolved).toLowerCase() === path.basename(parent).toLowerCase()
    && isFlatTestDirectory(parent)) {
    return parent;
  }
  return resolved;
}

function getExtensionPriority(fileName: string): number {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".exe")) return 0;
  if (lower.endsWith(".cpp")) return 1;
  if (lower.endsWith(".py")) return 2;
  return 3;
}

export function discoverCustomCheckers(
  problemPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  try {
    const isWindows = platform === "win32";
    const files = fs.readdirSync(problemPath).filter((file) => {
      const lower = file.toLowerCase();
      const isCandidate = lower.endsWith(".cpp")
        || lower.endsWith(".py")
        || (isWindows && lower.endsWith(".exe"));
      if (!isCandidate) return false;
      try {
        return fs.statSync(path.join(problemPath, file)).isFile();
      } catch {
        return false;
      }
    });

    return files.sort((a, b) => {
      const prioA = getExtensionPriority(a);
      const prioB = getExtensionPriority(b);
      if (prioA !== prioB) return prioA - prioB;
      return naturalSort(a, b);
    });
  } catch {
    return [];
  }
}

export function discoverInteractors(
  problemPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  try {
    const isWindows = platform === "win32";
    const files = fs.readdirSync(problemPath).filter((file) => {
      const lower = file.toLowerCase();
      const isCandidate = lower.startsWith("interactor") && (
        lower.endsWith(".cpp")
        || lower.endsWith(".py")
        || (isWindows && lower.endsWith(".exe"))
      );
      if (!isCandidate) return false;
      try {
        return fs.statSync(path.join(problemPath, file)).isFile();
      } catch {
        return false;
      }
    });

    return files.sort((a, b) => {
      const prioA = getExtensionPriority(a);
      const prioB = getExtensionPriority(b);
      if (prioA !== prioB) return prioA - prioB;
      return naturalSort(a, b);
    });
  } catch {
    return [];
  }
}
