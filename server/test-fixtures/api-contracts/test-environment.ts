import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { TOOLCHAIN_RELEASE_BLUEPRINTS } from "../../toolchains/manifest.js";
import { executorClient } from "../../executor/client.js";
import {
  drainToolchainDiscovery,
  resetToolchainDiscoveryRuntimeForTests,
} from "../../toolchains/discovery.js";
import { clearToolchainDetectionCache } from "../../toolchains/resolver.js";

export interface IsolatedTestEnvironment {
  readonly rootDir: string;
  readonly appDataDir: string;
  readonly tempDir: string;
  readonly mockSelectFile: string;
  setMockSelectDirectory(target: string): void;
  cleanup(): Promise<void>;
}

export interface TeardownStage {
  name: string;
  run: () => Promise<void> | void;
}

export async function runCompositionalTeardown(stages: readonly TeardownStage[]): Promise<void> {
  const errors: Array<{ name: string; error: unknown }> = [];
  for (const stage of stages) {
    try {
      await stage.run();
    } catch (err) {
      errors.push({ name: stage.name, error: err });
    }
  }
  if (errors.length > 0) {
    const messages = errors.map(
      (e) => `[${e.name}] ${e.error instanceof Error ? e.error.message : String(e.error)}`,
    );
    const underlying = errors.map((e) => (e.error instanceof Error ? e.error : new Error(String(e.error))));
    throw new AggregateError(
      underlying,
      `Compositional teardown failed in ${errors.length} stage(s):\n  ${messages.join("\n  ")}`,
    );
  }
}

const INITIAL_HOST_LOCALAPPDATA =
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const INITIAL_HOST_APPDATA =
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

export function getHostThemisDir(): string {
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(INITIAL_HOST_LOCALAPPDATA, "ThemisV2");
  }
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ThemisV2",
    );
  }
  return path.join(os.homedir(), ".themisv2-dev");
}

export function getHostExecutorDir(): string {
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(INITIAL_HOST_LOCALAPPDATA, "JudgeDesk", "JudgeDeskExecutor");
  }
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "JudgeDeskExecutor",
    );
  }
  return path.join(os.homedir(), ".judgedesk-executor");
}

export function getHostAppDataDir(): string {
  return getHostThemisDir();
}

export function recordHostAppDataHashes(targetDir?: string): Map<string, string> {
  const targetDirs = targetDir
    ? [{ base: targetDir, label: "" }]
    : [
        { base: getHostThemisDir(), label: "themis" },
        { base: getHostExecutorDir(), label: "executor" },
      ];

  const hashes = new Map<string, string>();
  for (const { base, label } of targetDirs) {
    if (!fs.existsSync(base)) {
      continue;
    }

    const walk = (current: string): void => {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const content = fs.readFileSync(full);
          const hash = crypto.createHash("sha256").update(content).digest("hex");
          const rel = path.relative(base, full).replace(/\\/g, "/");
          const key = label ? `${label}/${rel}` : rel;
          hashes.set(key, hash);
        }
      }
    };

    walk(base);
  }
  return hashes;
}

export function assertHostAppDataUnchanged(baseline: Map<string, string>, targetDir?: string): void {
  const current = recordHostAppDataHashes(targetDir);
  const errors: string[] = [];

  for (const [file, hash] of baseline.entries()) {
    const curHash = current.get(file);
    if (!curHash) {
      errors.push(`Host file deleted during test: ${file}`);
    } else if (curHash !== hash) {
      errors.push(`Host file mutated during test: ${file} (expected ${hash}, got ${curHash})`);
    }
  }

  for (const file of current.keys()) {
    if (!baseline.has(file)) {
      errors.push(`New file created in host AppData during test: ${file}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `CRITICAL ISOLATION BREACH: Host AppData was mutated during test execution!\n${errors.join("\n")}`,
    );
  }
}

export interface IsolatedTestEnvironmentOptions {
  removeSync?: (targetPath: string, options?: fs.RmOptions) => void;
}

export function createIsolatedTestEnvironment(
  options?: IsolatedTestEnvironmentOptions,
): IsolatedTestEnvironment {
  const removeSync = options?.removeSync || fs.rmSync;
  const prefix = path.join(os.tmpdir(), "jd_contract_env_");
  const rootDir = fs.mkdtempSync(prefix);
  const appDataDir = path.join(rootDir, "appdata");
  const tempDir = path.join(rootDir, "temp");
  const mockSelectFile = path.join(rootDir, "mock-select-directory.txt");

  const envKeys = [
    "THEMIS_APP_DATA_DIR",
    "THEMIS_RESOURCE_DIR",
    "TEMP",
    "TMP",
    "JUDGEDESK_TEST_SELECT_FILE",
    "JUDGEDESK_TEST_SELECT_DIRECTORY",
    "JUDGEDESK_SUPPRESS_EXCEL_SPAWN",
    "JUDGEDESK_DISTRIBUTION",
    "LOCALAPPDATA",
    "APPDATA",
  ] as const;
  const previousEnv: Record<string, string | undefined> = {};
  for (const key of envKeys) {
    previousEnv[key] = process.env[key];
  }

  const origHealthDescriptor = Object.getOwnPropertyDescriptor(executorClient, "health");
  let environmentConfigured = false;

  const rollback = (setupErr: unknown) => {
    const rollbackErrors: unknown[] = [];
    if (environmentConfigured) {
      try {
        if (origHealthDescriptor) {
          Object.defineProperty(executorClient, "health", origHealthDescriptor);
        } else {
          Reflect.deleteProperty(executorClient as unknown as object, "health");
        }
      } catch (e) {
        rollbackErrors.push(e);
      }
      try {
        for (const key of envKeys) {
          const prev = previousEnv[key];
          if (prev === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = prev;
          }
        }
        resetToolchainDiscoveryRuntimeForTests();
        clearToolchainDetectionCache();
      } catch (e) {
        rollbackErrors.push(e);
      }
    }
    try {
      if (fs.existsSync(rootDir)) {
        removeSync(rootDir, { recursive: true, force: true });
        if (fs.existsSync(rootDir)) {
          rollbackErrors.push(new Error(`Rollback deletion failed: root directory still present on disk at ${rootDir}`));
        }
      }
    } catch (e) {
      rollbackErrors.push(e);
    }

    const allErrors: unknown[] = [setupErr, ...rollbackErrors];
    if (allErrors.length === 1) {
      throw allErrors[0] instanceof Error ? allErrors[0] : new Error(String(allErrors[0]));
    }
    const errorObjects = allErrors.map((e) => (e instanceof Error ? e : new Error(String(e))));
    const messages = allErrors.map((e) => (e instanceof Error ? e.message : String(e)));
    throw new AggregateError(
      errorObjects,
      `createIsolatedTestEnvironment() setup and rollback failed:\n  ${messages.join("\n  ")}\nRetained path: ${rootDir}`,
    );
  };

  try {
    fs.writeFileSync(
      path.join(rootDir, ".judgedesk-test-root"),
      "judgedesk-test-owned\n",
      "utf8",
    );
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(mockSelectFile, "__CANCEL__", "utf8");

    const roamingDir = path.join(appDataDir, "Roaming");
    fs.mkdirSync(roamingDir, { recursive: true });

    // Set isolated environment variables
    process.env.THEMIS_APP_DATA_DIR = appDataDir;
    process.env.THEMIS_RESOURCE_DIR = path.resolve("build", "distribution-resources");
    process.env.TEMP = tempDir;
    process.env.TMP = tempDir;
    process.env.JUDGEDESK_TEST_SELECT_FILE = mockSelectFile;
    process.env.JUDGEDESK_TEST_SELECT_DIRECTORY = mockSelectFile;
    process.env.JUDGEDESK_SUPPRESS_EXCEL_SPAWN = "1";
    process.env.JUDGEDESK_DISTRIBUTION = "development";
    process.env.LOCALAPPDATA = appDataDir;
    process.env.APPDATA = roamingDir;
    environmentConfigured = true;

    // Mock executorClient.health to ready state for contract tests
    Object.defineProperty(executorClient, "health", {
      configurable: true,
      get: () => ({
        ready: true,
        mode: "windows-lpac-job",
        executorVersion: "1.5.0",
        diagnostics: [],
        networkBlocked: true,
        filesystemIsolated: true,
        processTreeControlled: true,
        memoryLimitSupported: true,
      }),
    });

  // Seed toolchains into isolated appDataDir/toolchains
  const toolchainsDir = path.join(appDataDir, "toolchains");
  fs.mkdirSync(toolchainsDir, { recursive: true });

  const hostPlatform = process.platform;
  for (const blueprint of Object.values(TOOLCHAIN_RELEASE_BLUEPRINTS)) {
    if (blueprint.platform !== hostPlatform) {
      continue;
    }
    const pkgDir = path.join(toolchainsDir, blueprint.id);
    fs.mkdirSync(pkgDir, { recursive: true });

    for (const comp of blueprint.components) {
      const fullPath = path.join(pkgDir, comp.relativePath);
      if (comp.kind === "executable") {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, "dummy binary for contract tests\n", "utf8");
      } else if (comp.kind === "support-root") {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }

    if (blueprint.license?.licenseFiles) {
      for (const lic of blueprint.license.licenseFiles) {
        const licPath = path.join(pkgDir, lic);
        fs.mkdirSync(path.dirname(licPath), { recursive: true });
        fs.writeFileSync(licPath, "license content\n", "utf8");
      }
    }

    const receipt = {
      schemaVersion: 1,
      packageId: blueprint.id,
      version: blueprint.version,
      archiveSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      entrypointComponentId: blueprint.entrypointComponentId,
      components: blueprint.components,
    };
    fs.writeFileSync(
      path.join(pkgDir, ".judgedesk-package.json"),
      JSON.stringify(receipt, null, 2),
      "utf8",
    );
  }

  // Seed default toolchains.json preferences
  const prefs = {
    schemaVersion: 2,
    profiles: {
      "cpp-legacy-v1": {
        mode: "managed",
      },
      "python3-v1": {
        mode: "managed",
      },
      "c-gcc14": {
        mode: "managed",
      },
      "pascal-fpc322": {
        mode: "managed",
      },
    },
  };
  fs.writeFileSync(
    path.join(appDataDir, "toolchains.json"),
    JSON.stringify(prefs, null, 2),
    "utf8",
  );

  // Seed execution policy
  const execPolicy = {
    schemaVersion: 1,
    allowResourceOnlyLocalExecution: true,
  };
  fs.writeFileSync(
    path.join(appDataDir, "toolchain-execution-policy-v1.json"),
    JSON.stringify(execPolicy, null, 2),
    "utf8",
  );

  // Seed discovery cache
  const discovery = {
    schemaVersion: 2,
    completedAt: "2026-09-20T10:00:00.000Z",
    profiles: {
      "c-gcc14": [],
      "cpp-legacy-v1": [],
      "pascal-fpc322": [],
      "python3-v1": [],
      "java-openjdk21": [],
      "scratch-desktop": [],
    },
  };
  fs.writeFileSync(
    path.join(appDataDir, "toolchain-discovery-v2.json"),
    JSON.stringify(discovery, null, 2),
    "utf8",
  );

  // Seed distribution state
  const distState = {
    schemaVersion: 1,
    distribution: "development",
  };
  fs.writeFileSync(
    path.join(appDataDir, "toolchain-distribution-state-v1.json"),
    JSON.stringify(distState, null, 2),
    "utf8",
  );

    resetToolchainDiscoveryRuntimeForTests();
    clearToolchainDetectionCache();
  } catch (err) {
    rollback(err);
  }

  function setMockSelectDirectory(target: string): void {
    fs.writeFileSync(mockSelectFile, target, "utf8");
  }

  let isCleanedUp = false;
  async function cleanup(): Promise<void> {
    if (isCleanedUp) {
      return;
    }

    const errors: unknown[] = [];
    let discoveryDrainFailed = false;

    // Stage 1: Drain discovery promises and active child processes
    try {
      await drainToolchainDiscovery();
    } catch (err) {
      discoveryDrainFailed = true;
      errors.push(err);
    }

    // Stage 1b: Shut down native executor child to release open handles on isolated root
    try {
      await executorClient.shutdown();
    } catch (err) {
      errors.push(err);
    }

    // Stage 2: Restore health descriptor
    try {
      if (origHealthDescriptor) {
        Object.defineProperty(executorClient, "health", origHealthDescriptor);
      } else {
        Reflect.deleteProperty(executorClient as unknown as object, "health");
      }
    } catch (err) {
      errors.push(err);
    }

    // Stage 3: Reset runtime caches
    try {
      if (!discoveryDrainFailed) {
        resetToolchainDiscoveryRuntimeForTests();
      }
      clearToolchainDetectionCache();
    } catch (err) {
      errors.push(err);
    }

    // Stage 4: Restore environment variables
    try {
      for (const key of envKeys) {
        const prev = previousEnv[key];
        if (prev === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = prev;
        }
      }
    } catch (err) {
      errors.push(err);
    }

    // Stage 5: Delete test root directory only if process/discovery quiescence succeeded
    if (discoveryDrainFailed) {
      errors.push(
        new Error(
          `[test-environment] Retained owned test root directory due to failed process/background quiescence: ${rootDir}`,
        ),
      );
    } else {
      let attempts = 0;
      let lastError: unknown = null;
      while (attempts < 10) {
        attempts++;
        try {
          if (fs.existsSync(rootDir)) {
            removeSync(rootDir, {
              recursive: true,
              force: true,
              maxRetries: 10,
              retryDelay: 50,
            });
          }
          if (!fs.existsSync(rootDir)) {
            break;
          }
        } catch (err) {
          lastError = err;
        }
        if (fs.existsSync(rootDir)) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }

      if (fs.existsSync(rootDir)) {
        const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
        errors.push(
          new Error(
            `[test-environment] Fail-closed: failed to fully remove root directory: ${rootDir}${detail}`,
          ),
        );
      } else {
        isCleanedUp = true;
      }
    }

    if (errors.length > 0) {
      const errorObjects = errors.map((e) => (e instanceof Error ? e : new Error(String(e))));
      const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
      throw new AggregateError(
        errorObjects,
        `[test-environment] Cleanup failed in ${errors.length} stage(s):\n  ${messages.join("\n  ")}`,
      );
    }

    isCleanedUp = true;
  }

  return {
    rootDir,
    appDataDir,
    tempDir,
    mockSelectFile,
    setMockSelectDirectory,
    cleanup,
  };
}
