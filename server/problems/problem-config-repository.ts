import fs from "fs";
import path from "path";
import type { NormalizedProblemConfig, ProblemConfig } from "../../shared/contracts.js";
import {
  normalizeProblemConfig,
  type ProblemConfigInput
} from "../../shared/problem-config.js";

const CONFIG_FILE_NAME = "Config.cfg";

export function readStoredProblemConfig(problemDirectory: string): ProblemConfigInput | null {
  const configPath = getProblemConfigPath(problemDirectory);
  if (!fs.existsSync(configPath)) return null;

  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid problem configuration: ${configPath}`);
  }
  return parsed as ProblemConfigInput;
}

export function writeStoredProblemConfig(problemDirectory: string, config: ProblemConfigInput): void {
  fs.writeFileSync(getProblemConfigPath(problemDirectory), JSON.stringify(config, null, 2), "utf8");
}

export function resolveProblemConfig(
  problemName: string,
  problemDirectory: string,
  requestConfig?: Partial<ProblemConfig> | null
): NormalizedProblemConfig {
  let storedConfig: ProblemConfigInput | null = null;
  try {
    storedConfig = readStoredProblemConfig(problemDirectory);
  } catch {}
  return normalizeProblemConfig(problemName, requestConfig, storedConfig);
}

export function getProblemConfigPath(problemDirectory: string): string {
  return path.join(path.resolve(problemDirectory), CONFIG_FILE_NAME);
}
