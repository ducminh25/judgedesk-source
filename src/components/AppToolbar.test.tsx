import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppUpdateState } from "../features/updates/useAppUpdater.js";
import { HelpButton, UpdateButton } from "./AppToolbar.js";

const resources = {
  en: {
    translation: {
      updates: {
        check: "Check for updates",
        checking: "Checking...",
        available: "Download {{version}}",
        downloading: "Downloading {{percent}}%",
        installQuestion: "Install update",
        upToDate: "Up to date",
        checkFailed: "Update check failed",
        downloadFailed: "Update download failed",
        installFailed: "Update installation failed",
        retry: "Try again",
      },
      helpCenter: { open: "Help" },
    },
  },
  vi: {
    translation: {
      updates: {
        check: "Kiểm tra cập nhật",
        checking: "Đang kiểm tra...",
        available: "Tải bản {{version}}",
        downloading: "Đang tải {{percent}}%",
        installQuestion: "Cài bản cập nhật",
        upToDate: "Đã là bản mới nhất",
        checkFailed: "Kiểm tra cập nhật thất bại",
        downloadFailed: "Tải bản cập nhật thất bại",
        installFailed: "Cài đặt bản cập nhật thất bại",
        retry: "Thử lại",
      },
      helpCenter: { open: "Hướng dẫn" },
    },
  },
};

async function renderUpdateButton(state: AppUpdateState, language: "en" | "vi") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources,
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UpdateButton
        state={state}
        disabled={false}
        onCheck={() => {}}
        onDownload={() => {}}
        onInstall={() => {}}
      />
    </I18nextProvider>,
  );
}

async function renderHelpButton(language: "en" | "vi") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources,
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <HelpButton onOpen={() => {}} />
    </I18nextProvider>,
  );
}

describe("toolbar update button", () => {
  it("shows a bounded English action instead of an icon-only control", async () => {
    const markup = await renderUpdateButton({ status: "idle" }, "en");

    assert.match(markup, />Check for updates</);
    assert.match(markup, /aria-label="Check for updates"/);
    assert.match(markup, /h-10/);
    assert.match(markup, /max-w-56/);
  });

  it("makes the Vietnamese download action explicit", async () => {
    const markup = await renderUpdateButton(
      { status: "available", version: "1.3.0" },
      "vi",
    );

    assert.match(markup, />Tải bản 1\.3\.0</);
  });

  it("keeps progress visible and disables the button while downloading", async () => {
    const markup = await renderUpdateButton(
      { status: "downloading", version: "1.3.0", percent: 42 },
      "en",
    );

    assert.match(markup, /disabled=""/);
    assert.match(markup, /animate-spin/);
    assert.match(markup, />Downloading 42%</);
  });

  it("exposes both the failure and retry action to assistive technology", async () => {
    const markup = await renderUpdateButton(
      { status: "error", phase: "download", message: "network" },
      "vi",
    );

    assert.match(markup, />Thử lại</);
    assert.match(
      markup,
      /aria-label="Tải bản cập nhật thất bại\. Thử lại"/,
    );
  });
});

describe("toolbar help button", () => {
  it("uses a visible English label and advertises the F1 shortcut", async () => {
    const markup = await renderHelpButton("en");

    assert.match(markup, />Help</);
    assert.match(markup, /aria-keyshortcuts="F1"/);
    assert.match(markup, /aria-label="Help \(F1\)"/);
    assert.match(markup, /h-10/);
  });

  it("uses an explicit Vietnamese label", async () => {
    const markup = await renderHelpButton("vi");

    assert.match(markup, />Hướng dẫn</);
    assert.match(markup, /aria-label="Hướng dẫn \(F1\)"/);
  });

  it("keeps Help immediately before Update in the toolbar", () => {
    const source = readFileSync(new URL("./AppToolbar.tsx", import.meta.url), "utf8");

    assert.match(source, /<HelpButton onOpen=\{onOpenHelp\} \/>\s*<UpdateButton/);
  });
});
