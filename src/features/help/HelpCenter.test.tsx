import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostStatus } from "../../types.js";
import enHelp from "./help.en.json";
import viHelp from "./help.vi.json";
import HelpCenter, {
  buildHelpDiagnosticsText,
  defaultAppDataPath,
  isHelpShortcut,
  type HelpDiagnostics,
  type HelpSectionId,
} from "./HelpCenter.js";

const resources = {
  en: {
    translation: {
      common: { close: "Close" },
      helpCenter: enHelp,
    },
  },
  vi: {
    translation: {
      common: { close: "Đóng" },
      helpCenter: viHelp,
    },
  },
};

const hostStatus: HostStatus = {
  gpp: { installed: true, version: "14.2.0" },
  python: { installed: true, version: "3.12.13" },
  tempDir: "C:\\Temp\\judgedesk",
  platform: "win32",
  isServerMode: false,
  build: {
    appVersion: "1.3.3",
    buildNumber: "51",
    gitCommit: "0123456789abcdef",
    builtAt: "2026-08-02T12:00:00.000Z",
  },
  secureRunner: {
    mode: "windows-lpac-job",
    ready: true,
    executorVersion: "1.3.3",
    diagnostics: [],
    networkBlocked: true,
    filesystemIsolated: true,
    processTreeControlled: true,
    memoryLimitSupported: true,
  },
};

async function renderHelp(language: "en" | "vi", section: HelpSectionId) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources,
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <HelpCenter
        initialSection={section}
        hostStatus={hostStatus}
        workspacePaths={{
          problems: "D:\\Contest\\Problems",
          contestants: "D:\\Contest\\Contestants",
        }}
        onClose={() => {}}
        onOpenToolchains={() => {}}
      />
    </I18nextProvider>,
  );
}

describe("Help Center", () => {
  it("renders a wide searchable offline dialog with stable context anchors", async () => {
    const markup = await renderHelp("en", "compile-flags");

    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-modal="true"/);
    assert.match(markup, /max-w-7xl/);
    assert.match(markup, /type="search"/);
    assert.match(markup, /Search help/);
    assert.match(markup, /data-help-anchor="compile-flags"/);
    assert.match(markup, /Per-problem compile flags/);
    assert.match(markup, /Config\.cfg/);
    assert.match(markup, /GNU\+\+20/);
    assert.match(markup, /-O2 -g/);
    assert.match(markup, /does not change the problem checker/);
    assert.match(markup, /deletes that problem&#x27;s old scores\/logs/);
  });

  it("explains the explicit security tradeoff of less-safe local mode", async () => {
    const markup = await renderHelp("en", "toolchains");

    assert.match(markup, /Allow less-safe local mode/);
    assert.match(markup, /Off \(default\)/);
    assert.match(markup, /full sandbox/);
    assert.match(markup, /TLE, MLE, and process-tree cleanup/);
    assert.match(markup, /does NOT isolate the filesystem or network/);
    assert.doesNotMatch(markup, /host process/i);
  });

  it("shows Vietnamese product identity and a non-affiliation disclaimer", async () => {
    const markup = await renderHelp("vi", "about");

    assert.match(markup, /Thông tin JudgeDesk/);
    assert.match(markup, />1\.3\.3</);
    assert.match(markup, />51</);
    assert.match(markup, /không phải Themis/);
    assert.match(markup, /không tuyên bố được Bộ Giáo dục và Đào tạo bảo trợ hoặc đặt hàng/);
    assert.match(markup, /Sao chép chẩn đoán/);
  });

  it("builds copyable diagnostics without embedding test or source contents", () => {
    const diagnostics: HelpDiagnostics = {
      appVersion: "1.3.3",
      buildNumber: "51",
      gitCommit: "abc123",
      builtAt: "2026-08-02T12:00:00.000Z",
      edition: "full",
      platform: "win32",
      arch: "x64",
      tempPath: "C:\\Temp\\judgedesk",
      appDataPath: "%LOCALAPPDATA%\\ThemisV2",
      toolchainsPath: "%LOCALAPPDATA%\\ThemisV2\\toolchains",
      problemsPath: "D:\\Contest\\Problems",
      contestantsPath: "D:\\Contest\\Contestants",
      discoveryStatus: "complete",
      discoveryCompletedAt: "2026-08-02T11:59:00.000Z",
      toolchains: [
        {
          id: "cpp-gnu",
          language: "C++",
          status: "submission_ready",
          source: "managed",
          version: "14.2.0",
          executablePath: "C:\\gcc\\bin\\g++.exe",
        },
        {
          id: "scratch-turbowarp-v1",
          language: "Scratch",
          status: "submission_ready",
          source: "managed",
          version: "1.0.0",
          executablePath: "built-in",
        },
      ],
    };

    const text = buildHelpDiagnosticsText(diagnostics);
    assert.match(text, /App version: 1\.3\.3/);
    assert.match(text, /Edition: full/);
    assert.match(text, /Problems path: D:\\Contest\\Problems/);
    assert.match(text, /Toolchain C\+\+ \(cpp-gnu\)/);
    assert.match(text, /Toolchain Scratch \(scratch-turbowarp-v1\): status=submission_ready; source=managed; version=1\.0\.0; path=built-in/);
    assert.doesNotMatch(text, /test contents|source contents/);
  });

  it("recognizes F1 only and documents the platform data roots", () => {
    assert.equal(isHelpShortcut({ key: "F1" }), true);
    assert.equal(isHelpShortcut({ key: "F2" }), false);
    assert.equal(defaultAppDataPath("win32"), "%LOCALAPPDATA%\\ThemisV2");
    assert.equal(defaultAppDataPath("darwin"), "~/Library/Application Support/ThemisV2");
  });

  it("wires F1 to the same Help Center state in App", () => {
    const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    const modalsSource = readFileSync(new URL("../../components/AppModals.tsx", import.meta.url), "utf8");

    assert.match(appSource, /if \(!isHelpShortcut\(event\)/);
    assert.match(appSource, /setHelpSection\(\(current\) => current \?\? "quick-start"\)/);
    assert.match(modalsSource, /<HelpCenter/);
  });
});
