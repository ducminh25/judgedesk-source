import fs from "fs";
import path from "path";
import { randomBytes } from "node:crypto";
import type { NormalizedProblemConfig, ProblemConfig } from "../../shared/contracts.js";
import { normalizeCompileConfig } from "../../shared/compile-config.js";
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
  const persistedConfig = {
    ...config,
    compile: normalizeCompileConfig(config.compile),
  };
  const destination = getProblemConfigPath(problemDirectory);
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(handle, JSON.stringify(persistedConfig, null, 2), "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* A rename already removed the temporary path. */ }
    throw error;
  }
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
