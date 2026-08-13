import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppUpdateState } from "../features/updates/useAppUpdater.js";
import { DonationButton, HelpButton, UpdateButton } from "./AppToolbar.js";

const resources = {
  en: {
    translation: {
      updates: {
        check: "Check for updates",
        checking: "Checking...",
        available: "Version {{version}} available",
        downloading: "Downloading {{percent}}%",
        installQuestion: "Install update",
        upToDate: "Up to date",
        checkFailed: "Update check failed",
        downloadFailed: "Update download failed",
        installFailed: "Update installation failed",
        retry: "Try again",
      },
      helpCenter: { open: "Help" },
      donation: { tooltip: "Buy me a coffee?" },
    },
  },
  vi: {
    translation: {
      updates: {
        check: "Kiểm tra cập nhật",
        checking: "Đang kiểm tra...",
        available: "Có bản {{version}}",
        downloading: "Đang tải {{percent}}%",
        installQuestion: "Cài bản cập nhật",
        upToDate: "Đã là bản mới nhất",
        checkFailed: "Kiểm tra cập nhật thất bại",
        downloadFailed: "Tải bản cập nhật thất bại",
        installFailed: "Cài đặt bản cập nhật thất bại",
        retry: "Thử lại",
      },
      helpCenter: { open: "Hướng dẫn" },
      donation: { tooltip: "Buy me a coffee? (Ủng hộ dự án?)" },
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
        onChoose={() => {}}
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
      {
        status: "available",
        version: "1.3.4",
        currentEdition: "core",
        candidates: {
          core: {
            edition: "core",
            version: "1.3.4",
            target: "windows-x86_64-core",
            downloadSizeBytes: 10,
            installedSizeBytes: 20,
          },
          full: {
            edition: "full",
            version: "1.3.4",
            target: "windows-x86_64-full",
            downloadSizeBytes: 30,
            installedSizeBytes: 40,
          },
        },
      },
      "vi",
    );

    assert.match(markup, />Có bản 1\.3\.4</);
  });

  it("keeps progress visible and disables the button while downloading", async () => {
    const markup = await renderUpdateButton(
      { status: "downloading", version: "1.3.4", edition: "full", percent: 42 },
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

describe("toolbar donation button", () => {
  it("shows the requested Vietnamese coffee tooltip", async () => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: "vi",
      resources,
      interpolation: { escapeValue: false },
    });
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DonationButton onOpen={() => {}} disabled={false} />
      </I18nextProvider>,
    );
    assert.match(markup, /title="Buy me a coffee\? \(Ủng hộ dự án\?\)"/);
  });

  it("keeps Coffee between Update and Tools", () => {
    const source = readFileSync(new URL("./AppToolbar.tsx", import.meta.url), "utf8");
    assert.match(source, /<UpdateButton[\s\S]*?<DonationButton[\s\S]*?<div ref=\{utilityMenuRef\}/);
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
