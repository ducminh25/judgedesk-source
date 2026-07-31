import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppUpdateState } from "../features/updates/useAppUpdater.js";
import { UpdateButton } from "./AppToolbar.js";

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
