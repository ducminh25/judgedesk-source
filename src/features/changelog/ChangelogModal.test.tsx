import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import ChangelogModal from "./ChangelogModal.js";

const resources = {
  vi: {
    translation: {
      common: { close: "Đóng" },
      changelog: {
        modalTitle: "Có gì mới trong JudgeDesk",
        modalSubtitle: "Nhật ký các thay đổi và cải tiến của phiên bản",
        currentVersion: "Hiện tại",
        allVersions: "Phiên bản",
        releaseDate: "Phát hành: {{date}}",
        viewFullNotes: "Xem trên GitHub",
        gotIt: "Đã hiểu",
        viewChangelog: "Nhật ký thay đổi",
      },
    },
  },
  en: {
    translation: {
      common: { close: "Close" },
      changelog: {
        modalTitle: "What's New in JudgeDesk",
        modalSubtitle: "Release notes and latest improvements",
        currentVersion: "Current",
        allVersions: "Versions",
        releaseDate: "Released: {{date}}",
        viewFullNotes: "View on GitHub",
        gotIt: "Got it",
        viewChangelog: "What's New",
      },
    },
  },
};

async function createI18n(lng = "vi") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    resources,
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("ChangelogModal", () => {
  it("renders latest version and past versions down to 1.2.5 in Vietnamese", async () => {
    const i18n = await createI18n("vi");
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ChangelogModal onClose={() => {}} />
      </I18nextProvider>,
    );

    assert.match(html, /Có gì mới trong JudgeDesk/);
    assert.match(
      html,
      /Trung Tâm Thông Báo, Bản Linux Full/,
    );
    assert.match(html, /JudgeDesk v1\.6\.1/);
    assert.match(html, /v1\.6\.0/);
    assert.match(html, /v1\.5\.5/);
    assert.match(html, /v1\.2\.5/);
    assert.match(html, /Đã hiểu/);
  });

  it("renders with initialVersion set to 1.2.5", async () => {
    const i18n = await createI18n("vi");
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ChangelogModal onClose={() => {}} initialVersion="1.2.5" />
      </I18nextProvider>,
    );

    assert.match(html, /JudgeDesk v1\.2\.5/);
    assert.match(html, /Bảo vệ Native &amp; Tính đúng đắn/);
  });

  it("renders in English", async () => {
    const i18n = await createI18n("en");
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ChangelogModal onClose={() => {}} />
      </I18nextProvider>,
    );

    assert.match(html, /What&#x27;s New in JudgeDesk/);
    assert.match(
      html,
      /Notification Center &amp; Linux Full Edition/,
    );
    assert.match(html, /Got it/);
  });
});
