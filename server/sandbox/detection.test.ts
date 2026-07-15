import assert from "node:assert/strict";
import test from "node:test";
import {
  detectSandboxEnvironment,
  SANDBOX_PROBE_TIMEOUT_MS,
  type SandboxCommandRunner,
} from "./detection.js";

test("macOS skips Windows-only WSL probes and bounds the Docker probe", () => {
  const calls: Array<{ command: string; timeout: number | undefined }> = [];
  const runCommand: SandboxCommandRunner = (command, options) => {
    calls.push({ command, timeout: options.timeout });
    throw new Error("not available");
  };

  const environment = detectSandboxEnvironment({
    platform: "darwin",
    runCommand,
  });

  assert.deepEqual(calls, [
    { command: "docker ps", timeout: SANDBOX_PROBE_TIMEOUT_MS },
  ]);
  assert.equal(environment.detection.wsl.installed, false);
  assert.equal(environment.detection.docker.installed, false);
});

test("Windows retains WSL detection with a timeout on every command", () => {
  const calls: Array<{ command: string; timeout: number | undefined }> = [];
  const runCommand: SandboxCommandRunner = (command, options) => {
    calls.push({ command, timeout: options.timeout });
    return "Ubuntu";
  };

  const environment = detectSandboxEnvironment({
    platform: "win32",
    runCommand,
  });

  assert.equal(environment.detection.wsl.installed, true);
  assert.equal(environment.detection.wsl.ready, true);
  assert.equal(environment.detection.docker.installed, true);
  assert.ok(calls.some(({ command }) => command === "wsl -l"));
  assert.ok(calls.some(({ command }) => command === "docker ps"));
  assert.ok(
    calls.every(({ timeout }) => timeout === SANDBOX_PROBE_TIMEOUT_MS),
  );
});
