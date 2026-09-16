import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Express } from "express";
import {
  isLocalPreferenceVerificationAccepted,
  registerToolchainRoutes,
} from "./toolchain-routes.js";
import {
  getPreferencesFilePath,
  loadPreferences,
  loadToolchainPreferenceSnapshot,
  savePreferences,
  type ToolchainPreferences,
} from "../toolchains/storage.js";
import {
  CPP_LANGUAGE_PROFILE_ID,
  getRegisteredLanguageProfile,
  LANGUAGE_REGISTRY_REVISION,
  PYTHON_LANGUAGE_PROFILE_ID,
  SCRATCH_LANGUAGE_PROFILE_ID,
  listRegisteredLanguageProfiles,
} from "../languages/registry.js";
import { getStoredProfilePreference } from "../toolchains/preferences-v2.js";
import { serverLifecycle } from "../platform/server-lifecycle.js";
import {
  normalizeHostArchitecture,
  TOOLCHAIN_CATALOG,
} from "../toolchains/manifest.js";
import {
  getLocalExecutionPolicyFilePath,
  loadLocalExecutionPolicy,
} from "../toolchains/execution-policy.js";

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

function currentHostSupportsProfile(profileId: string): boolean {
  const platform = os.platform();
  const arch = normalizeHostArchitecture(os.arch());
  return getRegisteredLanguageProfile(profileId)?.profile.supportedHosts.some(
    (host) => host.platform === platform && host.arch === arch,
  ) ?? false;
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

test("local path preference accepts detected-but-pending runtimes without claiming readiness", () => {
  assert.equal(isLocalPreferenceVerificationAccepted({ ready: true }), true);
  assert.equal(isLocalPreferenceVerificationAccepted({
    ready: false,
    diagnosticCode: "DETECTION_IN_PROGRESS",
  }), true);
  assert.equal(isLocalPreferenceVerificationAccepted({
    ready: false,
    diagnosticCode: "LOCAL_NOT_SANDBOX_COMPATIBLE",
  }), true);
  assert.equal(isLocalPreferenceVerificationAccepted({
    ready: false,
    diagnosticCode: "LOCAL_PATH_MISSING",
  }), false);
});

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
  app.put = capture("PUT");
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

test("GET exposes registry state without waiting for the remote package catalog", (t) => {
  useTemporaryAppData(t);
  const previousManifestUrl = process.env.THEMIS_TOOLCHAIN_MANIFEST_URL;
  process.env.THEMIS_TOOLCHAIN_MANIFEST_URL = "http://127.0.0.1:9/toolchains.json";
  t.after(() => {
    if (previousManifestUrl === undefined) delete process.env.THEMIS_TOOLCHAIN_MANIFEST_URL;
    else process.env.THEMIS_TOOLCHAIN_MANIFEST_URL = previousManifestUrl;
  });
  const handler = captureToolchainHandlers().get("GET /api/toolchains");
  assert.ok(handler);
  const response = createResponse();
  const returned = handler({ body: undefined, params: {} }, response);
  assert.equal(returned instanceof Promise, false);
  const payload = response.payload as {
    manifestStatus?: unknown;
    registryRevision?: unknown;
    profiles?: unknown[];
    mutationsBlocked?: unknown;
    executionPolicy?: {
      allowResourceOnlyLocalExecution?: unknown;
      status?: unknown;
    };
  };
  assert.equal(payload.manifestStatus, "loading");
  assert.equal(payload.registryRevision, LANGUAGE_REGISTRY_REVISION);
  assert.equal(
    payload.profiles?.length,
    listRegisteredLanguageProfiles().length,
  );
  assert.equal(payload.mutationsBlocked, false);
  assert.equal(
    payload.executionPolicy?.allowResourceOnlyLocalExecution,
    true,
  );
  assert.equal(payload.executionPolicy?.status, "default");
});

test("POST /api/toolchains/prewarm triggers background pre-warm without blocking", async (t) => {
  useTemporaryAppData(t);
  const handler = captureToolchainHandlers().get("POST /api/toolchains/prewarm");
  assert.ok(handler);
  const response = createResponse();
  const returned = handler({ body: undefined, params: {} }, response);
  assert.equal(returned instanceof Promise, false);
  assert.equal(response.statusCode, 200);
  const payload = response.payload as { success?: boolean };
  assert.equal(payload.success, true);
});

test("resource-only local execution requires an exact explicit policy mutation", async (t) => {
  useTemporaryAppData(t);
  const handler = captureToolchainHandlers().get(
    "PUT /api/toolchains/execution-policy",
  );
  assert.ok(handler);

  for (const body of [
    {},
    { allowResourceOnlyLocalExecution: "true" },
    { allowResourceOnlyLocalExecution: true, allowNetwork: true },
  ]) {
    const response = createResponse();
    await handler({ body, params: {} }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(fs.existsSync(getLocalExecutionPolicyFilePath()), false);
  }

  const enabled = createResponse();
  await handler(
    { body: { allowResourceOnlyLocalExecution: true }, params: {} },
    enabled,
  );
  assert.equal(enabled.statusCode, 200);
  assert.equal(loadLocalExecutionPolicy().allowResourceOnlyLocalExecution, true);

  const disabled = createResponse();
  await handler(
    { body: { allowResourceOnlyLocalExecution: false }, params: {} },
    disabled,
  );
  assert.equal(disabled.statusCode, 200);
  assert.equal(loadLocalExecutionPolicy().allowResourceOnlyLocalExecution, false);
});

test("deferred toolchain packages cannot be installed through the release API", async (t) => {
  useTemporaryAppData(t);
  const handler = captureToolchainHandlers().get(
    "POST /api/toolchains/:id/install",
  );
  assert.ok(handler);
  const response = createResponse();
  await handler(
    {
      body: undefined,
      params: {
        id: process.platform === "darwin"
          ? "go-macos-arm64"
          : "go-windows-x64",
      },
    },
    response,
  );
  assert.equal(response.statusCode, 404);
  assert.match(
    String((response.payload as { message?: unknown }).message),
    /not enabled in this release/,
  );
});

test("toolchain mutations fail closed while a judging session is active", async (t) => {
  useTemporaryAppData(t);
  loadToolchainPreferenceSnapshot();
  const storedBefore = fs.readFileSync(getPreferencesFilePath(), "utf8");
  const admission = serverLifecycle.tryStartJudgeSession(
    `toolchain-route-test-${Date.now()}`,
  );
  assert.equal(admission.accepted, true);
  if (!admission.accepted) return;
  t.after(() => admission.lease.finish());

  const handlers = captureToolchainHandlers();
  const getResponse = createResponse();
  await handlers.get("GET /api/toolchains")?.(
    { body: undefined, params: {} },
    getResponse,
  );
  assert.equal(
    (getResponse.payload as { mutationsBlocked?: unknown }).mutationsBlocked,
    true,
  );

  const preferenceResponse = createResponse();
  await handlers.get("PUT /api/toolchains/profiles/:profileId/preference")?.(
    {
      body: { mode: "none" },
      params: { profileId: CPP_LANGUAGE_PROFILE_ID },
    },
    preferenceResponse,
  );
  assert.equal(preferenceResponse.statusCode, 409);

  const legacyResponse = createResponse();
  await handlers.get("POST /api/toolchains/custom-path")?.(
    { body: { kind: "cpp", preferredSource: "system" }, params: {} },
    legacyResponse,
  );
  assert.equal(legacyResponse.statusCode, 409);

  const rescanResponse = createResponse();
  await handlers.get("POST /api/toolchains/rescan")?.(
    { body: undefined, params: {} },
    rescanResponse,
  );
  assert.equal(rescanResponse.statusCode, 409);

  const policyResponse = createResponse();
  await handlers.get("PUT /api/toolchains/execution-policy")?.(
    {
      body: { allowResourceOnlyLocalExecution: true },
      params: {},
    },
    policyResponse,
  );
  assert.equal(policyResponse.statusCode, 409);
  assert.equal(fs.existsSync(getLocalExecutionPolicyFilePath()), false);

  const hostArch = normalizeHostArchitecture(os.arch());
  const hostPackage = TOOLCHAIN_CATALOG.find(
    (entry) => entry.platform === os.platform() && entry.arch === hostArch,
  );
  if (hostPackage) {
    const installResponse = createResponse();
    await handlers.get("POST /api/toolchains/:id/install")?.(
      { body: undefined, params: { id: hostPackage.id } },
      installResponse,
    );
    assert.equal(installResponse.statusCode, 409);

    const uninstallResponse = createResponse();
    await handlers.get("DELETE /api/toolchains/:id")?.(
      { body: undefined, params: { id: hostPackage.id } },
      uninstallResponse,
    );
    assert.equal(uninstallResponse.statusCode, 409);
  }
  assert.equal(fs.readFileSync(getPreferencesFilePath(), "utf8"), storedBefore);
});

test("legacy v1 custom-path applies partial updates without erasing sibling preferences", async (t) => {
  useTemporaryAppData(t);
  const oldCppPath = path.join(os.tmpdir(), "judgedesk-old-g++.exe");
  const newCppPath = path.join(os.tmpdir(), "judgedesk-new-g++.exe");
  const rememberedPythonPath = path.join(os.tmpdir(), "judgedesk-python.exe");
  const initial: ToolchainPreferences = {
    preferredSourceCpp: "custom",
    customCppPath: oldCppPath,
    preferredSourcePython: "managed",
    customPythonPath: rememberedPythonPath,
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
    // v2 deliberately drops the legacy installed hint; disk is authoritative.
    installedToolchains: [],
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
    path: newCppPath,
  });
  const afterCpp: ToolchainPreferences = {
    ...afterPython,
    customCppPath: newCppPath,
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
    customCppPath: path.join(os.tmpdir(), "judgedesk-stable-g++.exe"),
    preferredSourcePython: "managed",
    customPythonPath: path.join(os.tmpdir(), "judgedesk-stable-python.exe"),
    installedToolchains: ["python-windows-x64"],
  };
  savePreferences(initial);
  const storedBefore = fs.readFileSync(getPreferencesFilePath(), "utf8");

  const handler = captureToolchainHandlers().get(
    "POST /api/toolchains/custom-path",
  );
  assert.ok(handler);

  const malformedPatches: unknown[] = [
    { kind: "not-a-language" },
    { kind: "cpp", path: 42 },
    { kind: "cpp", path: "relative-g++.exe" },
    { kind: "cpp", preferredSource: 42 },
  ];
  if (process.platform === "win32") {
    malformedPatches.push(
      { kind: "cpp", path: "//server/share/g++.exe" },
      { kind: "cpp", path: String.raw`\\?\C:\tools\g++.exe` },
    );
  }
  for (const body of malformedPatches) {
    const response = await invokeCustomPath(handler, body);
    assert.equal(response.statusCode, 400);
    assert.equal((response.payload as { success?: unknown }).success, false);
    assert.equal(
      fs.readFileSync(getPreferencesFilePath(), "utf8"),
      storedBefore,
    );
  }
});

test("profile preference route updates one stable registry ID and preserves dormant paths", {
  skip: currentHostSupportsProfile(CPP_LANGUAGE_PROFILE_ID)
    ? false
    : "profile preference mutation requires a supported JudgeDesk host",
}, async (t) => {
  useTemporaryAppData(t);
  savePreferences({
    preferredSourceCpp: "custom",
    customCppPath: String.raw`C:\remembered\g++.exe`,
    preferredSourcePython: "managed",
    customPythonPath: String.raw`C:\remembered\python.exe`,
  });
  const handler = captureToolchainHandlers().get(
    "PUT /api/toolchains/profiles/:profileId/preference",
  );
  assert.ok(handler);

  const response = createResponse();
  await handler(
    {
      body: { mode: "local_auto" },
      params: { profileId: CPP_LANGUAGE_PROFILE_ID },
    },
    response,
  );
  assert.equal(response.statusCode, 200);
  const snapshot = loadToolchainPreferenceSnapshot();
  assert.deepEqual(
    getStoredProfilePreference(snapshot.preferences, CPP_LANGUAGE_PROFILE_ID),
    { mode: "local_auto", localPath: String.raw`C:\remembered\g++.exe` },
  );
  assert.deepEqual(
    getStoredProfilePreference(snapshot.preferences, PYTHON_LANGUAGE_PROFILE_ID),
    { mode: "managed", localPath: String.raw`C:\remembered\python.exe` },
  );

  const scratchResponse = createResponse();
  await handler(
    {
      body: { mode: "managed" },
      params: { profileId: SCRATCH_LANGUAGE_PROFILE_ID },
    },
    scratchResponse,
  );
  assert.equal(scratchResponse.statusCode, 200);
  const updatedSnapshot = loadToolchainPreferenceSnapshot();
  assert.deepEqual(
    getStoredProfilePreference(updatedSnapshot.preferences, SCRATCH_LANGUAGE_PROFILE_ID),
    { mode: "managed" },
  );
});

test("profile preference route rejects unknown modes and unsafe paths without writing", async (t) => {
  useTemporaryAppData(t);
  loadToolchainPreferenceSnapshot();
  const storedBefore = fs.readFileSync(getPreferencesFilePath(), "utf8");
  const handler = captureToolchainHandlers().get(
    "PUT /api/toolchains/profiles/:profileId/preference",
  );
  assert.ok(handler);

  const invalidPreferences: unknown[] = [
    { mode: "system" },
    { mode: "local_path", localPath: "" },
    { mode: "managed", localPath: String.raw`C:\unexpected\g++.exe` },
    { mode: "none", extra: true },
  ];
  if (process.platform === "win32") {
    invalidPreferences.push(
      { mode: "local_path", localPath: "//server/share/g++.exe" },
      { mode: "local_path", localPath: String.raw`\\?\C:\tools\g++.exe` },
    );
  }
  for (const body of invalidPreferences) {
    const response = createResponse();
    await handler(
      { body, params: { profileId: CPP_LANGUAGE_PROFILE_ID } },
      response,
    );
    assert.equal(response.statusCode, 400);
    assert.equal(fs.readFileSync(getPreferencesFilePath(), "utf8"), storedBefore);
  }

  if (currentHostSupportsProfile(CPP_LANGUAGE_PROFILE_ID)) {
    const failedVerification = createResponse();
    await handler(
      {
        body: {
          mode: "local_path",
          localPath: path.join(os.tmpdir(), "judgedesk-does-not-exist", "g++"),
        },
        params: { profileId: CPP_LANGUAGE_PROFILE_ID },
      },
      failedVerification,
    );
    assert.equal(failedVerification.statusCode, 422);
    assert.equal(fs.readFileSync(getPreferencesFilePath(), "utf8"), storedBefore);
  }

  const unknownResponse = createResponse();
  await handler(
    { body: { mode: "none" }, params: { profileId: "unknown-profile" } },
    unknownResponse,
  );
  assert.equal(unknownResponse.statusCode, 404);
  assert.equal(fs.readFileSync(getPreferencesFilePath(), "utf8"), storedBefore);
});

test("certification plan is derived only from the selected local Windows compiler", {
  skip: process.platform === "win32" ? false : "Windows local certification is intentionally host-specific",
}, async (t) => {
  useTemporaryAppData(t);
  const toolchainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-plan-route-"));
  t.after(() => fs.rmSync(toolchainRoot, { recursive: true, force: true }));
  const compilerPath = path.join(toolchainRoot, "bin", "g++.exe");
  fs.mkdirSync(path.dirname(compilerPath), { recursive: true });
  fs.writeFileSync(compilerPath, "structural-compiler-fixture");
  savePreferences({
    preferredSourceCpp: "custom",
    customCppPath: compilerPath,
    preferredSourcePython: "managed",
  });
  const handlers = captureToolchainHandlers();
  const planHandler = handlers.get(
    "POST /api/toolchains/profiles/:profileId/certification-plan",
  );
  assert.ok(planHandler);
  const response = createResponse();
  await planHandler(
    { body: undefined, params: { profileId: CPP_LANGUAGE_PROFILE_ID } },
    response,
  );
  assert.equal(response.statusCode, 200);
  const payload = response.payload as {
    success: boolean;
    plan: { canonicalExecutablePath: string; fileCount: number; totalBytes: number };
  };
  assert.equal(payload.success, true);
  assert.equal(
    fs.realpathSync.native(payload.plan.canonicalExecutablePath),
    fs.realpathSync.native(compilerPath),
  );
  assert.equal(payload.plan.fileCount, 1);
  assert.equal(payload.plan.totalBytes, Buffer.byteLength("structural-compiler-fixture"));
});
