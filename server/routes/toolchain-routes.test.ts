import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Express } from "express";
import { registerToolchainRoutes } from "./toolchain-routes.js";
import {
  getPreferencesFilePath,
  loadPreferences,
  savePreferences,
  type ToolchainPreferences,
} from "../toolchains/storage.js";

type CapturedHandler = (
  request: { body: unknown; params: Record<string, string> },
  response: CapturedResponse,
) => unknown;

interface CapturedResponse {
  statusCode: number;
  payload: unknown;
  status(code: number): CapturedResponse;
  json(payload: unknown): CapturedResponse;
}

function useTemporaryAppData(t: TestContext): void {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-toolchain-routes-"),
  );
  const previousAppDataDir = process.env.THEMIS_APP_DATA_DIR;
  process.env.THEMIS_APP_DATA_DIR = tempDir;
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousAppDataDir === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previousAppDataDir;
  });
}

function captureToolchainHandlers(): Map<string, CapturedHandler> {
  const handlers = new Map<string, CapturedHandler>();
  const app: Record<string, unknown> = {};
  const capture = (method: string) => (
    routePath: string,
    handler: CapturedHandler,
  ) => {
    handlers.set(`${method} ${routePath}`, handler);
    return app;
  };
  app.get = capture("GET");
  app.post = capture("POST");
  app.delete = capture("DELETE");
  registerToolchainRoutes(app as unknown as Express);
  return handlers;
}

function createResponse(): CapturedResponse {
  const response: CapturedResponse = {
    statusCode: 200,
    payload: undefined,
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(payload) {
      response.payload = payload;
      return response;
    },
  };
  return response;
}

function assertLegacyPreferences(
  actual: unknown,
  expected: ToolchainPreferences,
): void {
  assert.ok(actual && typeof actual === "object");
  const preferences = actual as ToolchainPreferences;
  assert.deepEqual(
    {
      preferredSourceCpp: preferences.preferredSourceCpp,
      customCppPath: preferences.customCppPath,
      preferredSourcePython: preferences.preferredSourcePython,
      customPythonPath: preferences.customPythonPath,
      installedToolchains: preferences.installedToolchains,
    },
    expected,
  );
}

async function invokeCustomPath(
  handler: CapturedHandler,
  body: unknown,
): Promise<CapturedResponse> {
  const response = createResponse();
  await handler({ body, params: {} }, response);
  return response;
}

test("legacy v1 custom-path applies partial updates without erasing sibling preferences", async (t) => {
  useTemporaryAppData(t);
  const initial: ToolchainPreferences = {
    preferredSourceCpp: "custom",
    customCppPath: String.raw`C:\old\g++.exe`,
    preferredSourcePython: "managed",
    customPythonPath: String.raw`C:\remembered\python.exe`,
    installedToolchains: ["gcc-windows-x64"],
  };
  savePreferences(initial);

  const handler = captureToolchainHandlers().get(
    "POST /api/toolchains/custom-path",
  );
  assert.ok(handler);

  const pythonResponse = await invokeCustomPath(handler, {
    kind: "python",
    preferredSource: "system",
  });
  const afterPython: ToolchainPreferences = {
    ...initial,
    preferredSourcePython: "system",
  };
  assert.equal(pythonResponse.statusCode, 200);
  assert.equal(
    (pythonResponse.payload as { success?: unknown }).success,
    true,
  );
  assertLegacyPreferences(
    (pythonResponse.payload as { preferences?: unknown }).preferences,
    afterPython,
  );
  assertLegacyPreferences(loadPreferences(), afterPython);

  const cppResponse = await invokeCustomPath(handler, {
    kind: "cpp",
    path: String.raw`D:\new\g++.exe`,
  });
  const afterCpp: ToolchainPreferences = {
    ...afterPython,
    customCppPath: String.raw`D:\new\g++.exe`,
  };
  assert.equal(cppResponse.statusCode, 200);
  assert.equal((cppResponse.payload as { success?: unknown }).success, true);
  assertLegacyPreferences(
    (cppResponse.payload as { preferences?: unknown }).preferences,
    afterCpp,
  );
  assertLegacyPreferences(loadPreferences(), afterCpp);
});

test("legacy v1 custom-path rejects malformed patches without writing preferences", async (t) => {
  useTemporaryAppData(t);
  const initial: ToolchainPreferences = {
    preferredSourceCpp: "system",
    customCppPath: String.raw`C:\stable\g++.exe`,
    preferredSourcePython: "managed",
    customPythonPath: String.raw`C:\stable\python.exe`,
    installedToolchains: ["python-windows-x64"],
  };
  savePreferences(initial);
  const storedBefore = fs.readFileSync(getPreferencesFilePath(), "utf8");

  const handler = captureToolchainHandlers().get(
    "POST /api/toolchains/custom-path",
  );
  assert.ok(handler);

  for (const body of [
    { kind: "not-a-language" },
    { kind: "cpp", path: 42 },
    { kind: "cpp", preferredSource: 42 },
  ]) {
    const response = await invokeCustomPath(handler, body);
    assert.equal(response.statusCode, 400);
    assert.equal((response.payload as { success?: unknown }).success, false);
    assert.equal(
      fs.readFileSync(getPreferencesFilePath(), "utf8"),
      storedBefore,
    );
  }
});
