import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { ToolchainState } from "./useToolchains.js";

async function renderWithTranslations(element: ReactNode) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: {
      en: {
        translation: {
          toolchains: {
            managerTitle: "Compilers & Runtimes Manager",
            close: "Close Manager",
            loadingState: "Loading compiler configurations...",
            loadingHint: "Loading registry choices.",
            cppSettings: "C/C++ Compiler Settings",
            pythonSettings: "Python Interpreter Settings",
            status: "Status",
            uninstall: "Uninstall",
            cancel: "Cancel",
            registry: {
              language: "Language",
              sourceSelection: "Compiler/runtime source",
              actions: "Actions",
              experimental: "Experimental",
              sources: {
                none: "None",
                managed: "Managed by toolchain",
                local_path: "Local (path)",
                local_auto: "Local (auto-detect)",
              },
              statuses: {
                not_available: "Not available",
                checker_only: "Checker only",
                submission_ready: "Submission ready",
              },
              verifyAndUse: "Use this path",
              advanced: "Advanced",
              supportedLocalVersions: "Tested local versions",
              localExecution: {
                freeze_required: "Freeze required",
                managed_only: "Managed only",
              },
              freezeForContest: "Freeze for contest",
              localPolicyLegacyDisabled: "Legacy resource-only execution is disabled. Local compilers are checked automatically in the strict sandbox.",
              localPolicyRecovery: "The saved execution policy could not be read. Strict sandbox isolation remains required.",
              resourceOnly: {
                title: "Advanced local execution",
                description: "Filesystem and network are not isolated.",
                toggle: "Allow less-secure local execution",
                enabled: "Enabled",
                disabled: "Off (recommended)",
                recovery: "Invalid saved policy was disabled.",
                confirm: "Enable less-secure local execution?",
              },
              downloadAndApply: "Download and apply for JudgeDesk",
              applyManaged: "Apply managed package",
              uninstallConfirm: "Confirm uninstall",
              managedUnavailable: "No managed package",
            },
          },
          languages: { cpp: "C++", python: "Python" },
          directoryPicker: { browse: "Browse..." },
          problemConfig: { save: "Save" },
          toolbar: { statusMenu: { title: "Tools", checking: "Checking..." } },
          common: { close: "Close" },
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{element}</I18nextProvider>,
  );
}

describe("toolchain settings UI regressions", () => {
  it("keeps polling cached refreshes and local compatibility probes", async () => {
    Object.assign(globalThis, {
      window: { location: { origin: "http://localhost:5173" } },
    });
    const { hasRunningOperation } = await import("./useToolchains.js");
    const state = {
      discovery: { status: "complete", refreshing: true },
      manifestStatus: "ready",
      toolchains: [],
      profiles: [],
    } as unknown as ToolchainState;
    assert.equal(hasRunningOperation(state), true);

    state.discovery.refreshing = false;
    state.profiles = [{
      active: { localProbe: { status: "checking" } },
    } as ToolchainState["profiles"][number]];
    assert.equal(hasRunningOperation(state), true);

    state.profiles[0].active.localProbe = { status: "compatible" };
    assert.equal(hasRunningOperation(state), false);
  });

  it("keeps the Manager action visible before host detection completes", async () => {
    Object.assign(globalThis, {
      window: { location: { origin: "http://localhost:5173" } },
    });
    const { HostStatusMenu } = await import("../../components/AppToolbar.js");
    const markup = await renderWithTranslations(
      <HostStatusMenu status={null} onClose={() => {}} onOpenToolchains={() => {}} />,
    );

    assert.match(markup, /Checking\.\.\./);
    assert.match(markup, /Compilers &amp; Runtimes Manager/);
  });

  it("explains disabled legacy policies without offering a less-secure toggle", async () => {
    const { LocalExecutionPolicyNotice } = await import("./ToolchainManager.js");
    const markup = await renderWithTranslations(
      <LocalExecutionPolicyNotice policy={{
        schemaVersion: 1,
        allowResourceOnlyLocalExecution: false,
        status: "recovery",
        diagnostic: "RESOURCE_ONLY_LOCAL_EXECUTION_DISABLED",
      }} />,
    );
    assert.match(markup, /Legacy resource-only execution is disabled/);
    assert.match(markup, /checked automatically/);
    assert.doesNotMatch(markup, /type="checkbox"|role="switch"/);
    const healthy = await renderWithTranslations(
      <LocalExecutionPolicyNotice policy={{
        schemaVersion: 1,
        allowResourceOnlyLocalExecution: false,
        status: "ready",
      }} />,
    );
    assert.equal(healthy, "");
  });

  it("resumes polling after an idle manager selects a pending local compiler", async () => {
    const { refreshToolchainState } = await import("./useToolchains.js");
    const pending = {
      discovery: { status: "complete", refreshing: false },
      manifestStatus: "ready",
      toolchains: [],
      profiles: [{ active: { localProbe: { status: "checking" } } }],
    } as unknown as ToolchainState;
    let polling = false;
    assert.equal(await refreshToolchainState(async () => pending, () => { polling = true; }), pending);
    assert.equal(polling, true);
    polling = false;
    pending.profiles[0].active.localProbe = { status: "compatible" };
    assert.equal(await refreshToolchainState(async () => pending, () => { polling = true; }), pending);
    assert.equal(polling, false);
    const source = readFileSync(new URL("./useToolchains.ts", import.meta.url), "utf8");
    const mutation = source.slice(source.indexOf("const setProfilePreference ="), source.indexOf("const rescan ="));
    assert.match(mutation, /await refreshState\(\)/);
    assert.doesNotMatch(mutation, /await fetchState\(\)/);
  });

  it("refreshes the host automatically while toolchain selection is still pending", () => {
    const source = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    const request = source.slice(source.indexOf("const requestHostStatus = useCallback"), source.indexOf("// Themis Toolchain Detection"));
    assert.match(request, /createHostStatusRefresh/);
    assert.match(request, /loadToolchains: loadHelpToolchains/);
    assert.match(request, /refresh\.dispose\(\)/);
  });

  it("Themis import cannot mutate execution isolation policy", () => {
    const source = readFileSync(new URL("./useThemisPromptModal.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /execution-policy|allowResourceOnlyLocalExecution/);
  });

  it("renders every registry profile with four fixed source radios and inline actions", async () => {
    Object.assign(globalThis, {
      window: { location: { origin: "http://localhost:5173" } },
    });
    const { ToolchainRegistryTable } = await import("./ToolchainManager.js");
    const profiles = [
      {
        id: "cpp-legacy-v1",
        version: 1,
        displayNameKey: "languages.cpp",
        stability: "stable" as const,
        extensions: [".cpp"],
        kind: "cpp" as const,
        supportedOnHost: true,
        localPolicy: {
          supportedVersions: ["9.2.0", "14.2.0", "16.1.0"],
          executionMode: "freeze_required" as const,
        },
        selection: { mode: "local_path" as const, localPath: "C:\\gcc\\g++.exe" },
        detected: true,
        status: "not_available" as const,
        roles: { submissionReady: false, checkerReady: false },
        diagnostic: {
          code: "CERTIFICATION_REQUIRED",
          messageKey: "toolchains.diagnostics.CERTIFICATION_REQUIRED",
        },
        active: {
          kind: "cpp" as const,
          source: "custom" as const,
          executablePath: "C:\\gcc\\g++.exe",
          version: "14.2.0",
          ready: false,
        },
        candidates: [],
        sources: {
          none: { available: true },
          managed: { available: true },
          local_path: { available: true },
          local_auto: { available: true },
        },
        managedPackage: {
          id: "gcc-windows-x64",
          version: "14.2.0",
          installed: false,
          uninstallable: false,
          downloadAvailable: true,
          progress: {
            id: "gcc-windows-x64",
            status: "idle" as const,
            percent: 0,
            bytesReceived: 0,
            totalBytes: 1,
          },
        },
        certification: {
          supported: true,
          required: true,
          canCertify: true,
        },
      },
      {
        id: "python-cpython312",
        version: 1,
        displayNameKey: "languages.python",
        stability: "stable" as const,
        extensions: [".py"],
        kind: "python" as const,
        supportedOnHost: true,
        localPolicy: {
          supportedVersions: ["3.12.13"],
          executionMode: "managed_only" as const,
        },
        selection: { mode: "managed" as const },
        detected: true,
        status: "submission_ready" as const,
        roles: { submissionReady: true, checkerReady: true },
        active: {
          kind: "python" as const,
          source: "managed" as const,
          executablePath: "C:\\python\\python.exe",
          version: "3.12.13",
          ready: true,
        },
        candidates: [],
        sources: {
          none: { available: true },
          managed: { available: true },
          local_path: { available: true },
          local_auto: { available: true },
        },
        managedPackage: {
          id: "python-windows-x64",
          version: "3.12.13",
          installed: true,
          origin: "downloaded" as const,
          integrity: "verified-receipt" as const,
          uninstallable: true,
          downloadAvailable: true,
          progress: {
            id: "python-windows-x64",
            status: "idle" as const,
            percent: 0,
            bytesReceived: 0,
            totalBytes: 1,
          },
        },
      },
    ];
    const markup = await renderWithTranslations(
      <ToolchainRegistryTable
        profiles={profiles}
        discoveryStatus="complete"
        preferenceLocked={false}
        onSetPreference={async () => true}
        onInstall={async () => true}
        onCancel={async () => {}}
        onUninstall={async () => true}
        onPlanCertification={async () => null}
        onCertify={async () => true}
      />,
    );

    assert.equal((markup.match(/type="radio"/g) || []).length, 8);
    assert.equal((markup.match(/Managed by toolchain/g) || []).length, 2);
    assert.match(markup, /Not available/);
    assert.match(markup, /Submission ready/);
    assert.match(markup, /Download and apply for JudgeDesk/);
    assert.doesNotMatch(markup, /toolchains\.registry\.advanced/);
    assert.doesNotMatch(markup, /Tested local versions/);
    assert.match(markup, /Freeze for contest/);
    assert.match(markup, /Uninstall/);

    const lockedMarkup = await renderWithTranslations(
      <ToolchainRegistryTable
        profiles={profiles}
        discoveryStatus="complete"
        preferenceLocked
        onSetPreference={async () => true}
        onInstall={async () => true}
        onCancel={async () => {}}
        onUninstall={async () => true}
        onPlanCertification={async () => null}
        onCertify={async () => true}
      />,
    );
    assert.equal(
      (lockedMarkup.match(/<input[^>]*type="radio"[^>]*disabled=""/g) || [])
        .length,
      8,
    );
  });

  it("does not reload remembered problems when toolchain dialogs close", () => {
    const appSource = readFileSync(
      new URL("../../components/AppModals.tsx", import.meta.url),
      "utf8",
    );
    const modalStart = appSource.indexOf("{openToolchains &&");
    const modalEnd = appSource.indexOf("<InstallUpdateDialog", modalStart);
    assert.notEqual(modalStart, -1);
    assert.notEqual(modalEnd, -1);
    assert.doesNotMatch(
      appSource.slice(modalStart, modalEnd),
      /handleFetchProblems/,
    );
  });

  it("removes LocalExecutionPolicyPanel and streamlines F6 manager modal", () => {
    const source = readFileSync(
      new URL("./ToolchainManager.tsx", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /LocalExecutionPolicyPanel/);
    assert.doesNotMatch(source, /supportedLocalVersions/);
    assert.match(source, /\/api\/toolchains\/prewarm/);
  });

  it("does not force a toolchain wizard on first launch", () => {
    const appSource = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(appSource, /ToolchainSetupModal/);
    assert.doesNotMatch(appSource, /isToolchainSetupCompleted/);
  });

  it("refreshes host toolchain status every time the status menu is opened", () => {
    const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    const requestStart = appSource.indexOf("const requestHostStatus = useCallback");
    const requestEnd = appSource.indexOf("useEffect(() =>", requestStart);
    assert.notEqual(requestStart, -1);
    assert.notEqual(requestEnd, -1);
    const requestSource = appSource.slice(requestStart, requestEnd);
    assert.doesNotMatch(requestSource, /hostStatus\s*\|\|/);
    assert.match(requestSource, /hostStatusRefreshRef\.current\?\.request\(\)/);
  });
});
