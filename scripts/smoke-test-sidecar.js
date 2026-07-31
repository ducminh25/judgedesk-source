import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STARTUP_TIMEOUT_MS = 30_000;
// macOS may spend several seconds validating an ad-hoc signed Full bundle the
// first time its sidecar is launched from a freshly mounted DMG. The gate still
// requires a non-zero exit and verifies that no listener remains; this longer
// deadline avoids mistaking cold code-signature validation for token acceptance.
const STARTUP_GATE_REJECTION_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const HTTP_REQUEST_TIMEOUT_MS = 5_000;
const EXPECTED_CONTESTANTS = ["Contestant 2", "Contestant 10"];
const EXPECTED_PROBLEMS = ["Problem A", "Problem B"];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback port for the smoke test.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let exit = await waitForProcessExit(child, 2_000);
  if (exit === null) {
    child.kill("SIGKILL");
    exit = await waitForProcessExit(child, 2_000);
  }
  if (exit === null) {
    throw new Error(`Sidecar process ${child.pid ?? "(unknown PID)"} did not exit after SIGKILL.`);
  }
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => null),
  ]);
}

async function assertPortIsFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function fetchJsonWithinDeadline(url, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`HTTP smoke-test deadline expired before requesting ${url}.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(remaining, HTTP_REQUEST_TIMEOUT_MS),
  );
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json();
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyStartupGateRejectsMissingToken(
  executablePath,
  { args = [], timeoutMs = STARTUP_GATE_REJECTION_TIMEOUT_MS } = {},
) {
  const resolvedExecutable = path.resolve(executablePath);
  const port = await allocatePort();
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "themis-sidecar-gate-"),
  );
  const environment = {
    ...process.env,
    PORT: String(port),
    THEMIS_APP_DATA_DIR: path.join(temporaryRoot, "app-data"),
    THEMIS_RESOURCE_DIR: temporaryRoot,
  };
  delete environment.JUDGEDESK_BOOTSTRAP_TOKEN;
  const stdout = [];
  const stderr = [];
  const child = spawn(resolvedExecutable, args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  try {
    const exit = await waitForProcessExit(child, timeoutMs);
    if (exit === null) {
      throw new Error("Sidecar stayed alive without an authenticated startup token.");
    }
    if (exit.code === 0) {
      throw new Error("Sidecar accepted startup without an authenticated token.");
    }
    await assertPortIsFree(port);
    console.log("Sidecar startup gate rejected a missing token before listening.");
  } catch (error) {
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        "--- sidecar stdout ---",
        stdout.join("") || "(empty)",
        "--- sidecar stderr ---",
        stderr.join("") || "(empty)",
      ].join("\n"),
      { cause: error },
    );
  } finally {
    await stopProcess(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyWorkspaceRoutes(baseUrl, temporaryRoot, deadline) {
  const contestantsDirectory = path.join(temporaryRoot, "Contestants Folder");
  const problemsDirectory = path.join(temporaryRoot, "Tests Folder");
  for (const name of EXPECTED_CONTESTANTS) {
    fs.mkdirSync(path.join(contestantsDirectory, name), { recursive: true });
  }
  for (const name of EXPECTED_PROBLEMS) {
    fs.mkdirSync(path.join(problemsDirectory, name), { recursive: true });
  }

  const { response: contestantsResponse, body: contestants } = await fetchJsonWithinDeadline(
    `${baseUrl}/api/fetch-contestants?path=${encodeURIComponent(contestantsDirectory)}`,
    deadline,
  );
  if (
    !contestantsResponse.ok ||
    JSON.stringify(contestants.data) !== JSON.stringify(EXPECTED_CONTESTANTS)
  ) {
    throw new Error(
      `Contestant discovery smoke test failed: ${JSON.stringify(contestants)}`,
    );
  }

  const { response: problemsResponse, body: problems } = await fetchJsonWithinDeadline(
    `${baseUrl}/api/fetch-problems?path=${encodeURIComponent(problemsDirectory)}`,
    deadline,
  );
  if (
    !problemsResponse.ok ||
    JSON.stringify(problems.data) !== JSON.stringify(EXPECTED_PROBLEMS)
  ) {
    throw new Error(
      `Problem discovery smoke test failed: ${JSON.stringify(problems)}`,
    );
  }
}

export async function smokeTestSidecar(
  executablePath,
  {
    args = [],
    resourceDirectory,
    timeoutMs = STARTUP_TIMEOUT_MS,
    requireCpp = false,
  } = {},
) {
  const resolvedExecutable = path.resolve(executablePath);
  if (!fs.existsSync(resolvedExecutable)) {
    throw new Error(`Sidecar executable was not found: ${resolvedExecutable}`);
  }
  if (requireCpp) {
    const compatibilityHeader = path.join(
      path.resolve(resourceDirectory || ""),
      "compiler-compat",
      "include",
      "bits",
      "stdc++.h",
    );
    if (!resourceDirectory || !fs.statSync(compatibilityHeader, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Packaged C++ compatibility header was not found: ${compatibilityHeader}`);
    }
  }

  const port = await allocatePort();
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "themis-sidecar-smoke-"),
  );
  const stdout = [];
  const stderr = [];
  const startupToken = crypto.randomBytes(32).toString("hex");
  let spawnError;
  const child = spawn(resolvedExecutable, args, {
    env: {
      ...process.env,
      PORT: String(port),
      THEMIS_APP_DATA_DIR: path.join(temporaryRoot, "app-data"),
      THEMIS_RESOURCE_DIR: resourceDirectory
        ? path.resolve(resourceDirectory)
        : temporaryRoot,
      JUDGEDESK_BOOTSTRAP_TOKEN: startupToken,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdin.write(`JUDGEDESK_START/1 ${startupToken}\n`, (error) => {
    if (error) spawnError = error;
  });

  const deadline = Date.now() + timeoutMs;
  let lastHealthError;
  try {
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`Sidecar could not be started: ${spawnError.message}`);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Sidecar exited before it became healthy (code=${child.exitCode}, signal=${child.signalCode}).`,
        );
      }
      let healthy;
      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const { response, body: status } = await fetchJsonWithinDeadline(
          `${baseUrl}/api/status`,
          deadline,
        );
        if (response.ok) {
          healthy = { baseUrl, status };
        }
      } catch (error) {
        // The server has not started listening yet.
        lastHealthError = error;
      }
      if (healthy) {
        const { baseUrl, status } = healthy;
        if (requireCpp && !status.gpp?.installed) {
          throw new Error(
            `Packaged sidecar did not detect Apple Clang: ${JSON.stringify(status.gpp)}`,
          );
        }
        await verifyWorkspaceRoutes(baseUrl, temporaryRoot, deadline);
        await new Promise((resolve, reject) => {
          child.stdin.end((error) => (error ? reject(error) : resolve()));
        });
        const parentLossExit = await waitForProcessExit(child, 5_000);
        if (parentLossExit === null) {
          throw new Error("Sidecar stayed alive after its authenticated parent channel closed.");
        }
        if (parentLossExit.code !== 70 || parentLossExit.signal !== null) {
          throw new Error(
            `Sidecar parent-loss exit was not fail-closed (code=${parentLossExit.code}, signal=${parentLossExit.signal}).`,
          );
        }
        await assertPortIsFree(port);
        console.log(`Sidecar smoke test passed on port ${port}.`);
        console.log("Contestant and problem discovery routes passed.");
        console.log("Authenticated parent-channel EOF stopped the sidecar and released its port.");
        console.log(JSON.stringify(status, null, 2));
        return status;
      }
      await delay(POLL_INTERVAL_MS);
    }
    const detail = lastHealthError instanceof Error
      ? ` Last check: ${lastHealthError.message}`
      : "";
    throw new Error(`Sidecar did not become healthy within ${timeoutMs} ms.${detail}`);
  } catch (error) {
    const output = [
      error.message,
      "--- sidecar stdout ---",
      stdout.join("") || "(empty)",
      "--- sidecar stderr ---",
      stderr.join("") || "(empty)",
    ].join("\n");
    throw new Error(output, { cause: error });
  } finally {
    await stopProcess(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const [, , executablePath, resourceDirectory, ...flags] = process.argv;
  if (!executablePath) {
    throw new Error(
      "Usage: node scripts/smoke-test-sidecar.js <executable> [resource-directory]",
    );
  }
  await verifyStartupGateRejectsMissingToken(executablePath);
  await smokeTestSidecar(executablePath, {
    resourceDirectory,
    requireCpp: flags.includes("--require-cpp"),
  });
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
