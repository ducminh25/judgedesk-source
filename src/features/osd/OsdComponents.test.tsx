import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import OsdStatusBadge from "./OsdStatusBadge.js";
import OsdSettingsModal from "./OsdSettingsModal.js";
import type { OsdStatusState } from "./useOsdSession.js";

const resources = {
  vi: {
    translation: {
      osd: {
        title: "Chấm bài trực tuyến (Online Judge / OSD)",
        badgeLabel: "OSD",
        statusActive: "Đang theo dõi bài nộp mới",
        statusInactive: "Chấm trực tuyến đang tắt",
        stats: "Hàng đợi: {{queue}} bài | Đã xử lý: {{total}} bài",
        startButton: "Bắt đầu theo dõi",
        stopButton: "Dừng theo dõi",
        folderLabel: "Thư mục nộp bài chung (OSD Shared Folder)",
      },
      common: {
        close: "Đóng",
        browse: "Duyệt...",
      },
    },
  },
};

async function createI18n() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources,
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("OSD UI components", () => {
  it("renders OsdStatusBadge inactive state", async () => {
    const i18n = await createI18n();
    const status: OsdStatusState = {
      active: false,
      paused: false,
      osdPath: null,
      contestantsPath: null,
      testPath: null,
      enableLog: true,
      queueLength: 0,
      currentJob: null,
      totalProcessed: 0,
    };

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <OsdStatusBadge status={status} onClick={() => {}} />
      </I18nextProvider>,
    );

    assert.match(html, /OSD/);
    assert.doesNotMatch(html, /animate-ping/);
  });

  it("renders OsdStatusBadge active state with queue count", async () => {
    const i18n = await createI18n();
    const status: OsdStatusState = {
      active: true,
      paused: false,
      osdPath: "/path/to/osd",
      contestantsPath: "/path/to/contestants",
      testPath: "/path/to/tests",
      enableLog: true,
      queueLength: 5,
      currentJob: null,
      totalProcessed: 12,
    };

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <OsdStatusBadge status={status} onClick={() => {}} />
      </I18nextProvider>,
    );

    assert.match(html, /animate-ping/);
    assert.match(html, />5</);
  });

  it("renders OsdSettingsModal", async () => {
    const i18n = await createI18n();
    const status: OsdStatusState = {
      active: false,
      paused: false,
      osdPath: "/contest/Submit",
      contestantsPath: "/contest/Contestants",
      testPath: "/contest/Tests",
      enableLog: true,
      queueLength: 0,
      currentJob: null,
      totalProcessed: 0,
    };

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <OsdSettingsModal
          status={status}
          contestantsPath="/contest/Contestants"
          testPath="/contest/Tests"
          onStart={async () => ({ success: true })}
          onStop={async () => {}}
          onClose={() => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Chấm bài trực tuyến/);
    assert.match(html, /Bắt đầu theo dõi/);
    assert.match(html, /Thư mục nộp bài chung/);
  });
});
