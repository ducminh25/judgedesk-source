import assert from "node:assert/strict";
import { test } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import StartupFailure from "./StartupFailure.js";

async function renderFailure(language: "en" | "vi") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources: {
      en: {
        translation: {
          startupFailure: {
            title: "JudgeDesk could not start",
            reason: "The secure connection to the grading service could not be established.",
            action: "Try again. If the problem persists, close and reopen JudgeDesk.",
            retry: "Try again",
            retrying: "Trying again...",
          },
        },
      },
      vi: {
        translation: {
          startupFailure: {
            title: "JudgeDesk không thể khởi động",
            reason: "Không thể thiết lập kết nối bảo mật tới dịch vụ chấm bài.",
            action: "Hãy thử lại. Nếu lỗi vẫn còn, hãy đóng và mở lại JudgeDesk.",
            retry: "Thử lại",
            retrying: "Đang thử lại...",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <StartupFailure retrying={false} onRetry={() => {}} />
    </I18nextProvider>,
  );
}

test("startup failure is actionable and accessible in Vietnamese", async () => {
  const html = await renderFailure("vi");

  assert.match(html, /role="alert"/);
  assert.match(html, /JudgeDesk không thể khởi động/);
  assert.match(html, /kết nối bảo mật/);
  assert.match(html, /Thử lại/);
  assert.match(html, /type="button"/);
});

test("startup failure has the same actionable structure in English", async () => {
  const html = await renderFailure("en");

  assert.match(html, /JudgeDesk could not start/);
  assert.match(html, /secure connection/);
  assert.match(html, /Try again/);
});
