import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import ProgressWindow from "./ProgressWindow.js";

async function createI18n() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources: {
      vi: {
        translation: {
          progress: {
            batchGrading: "Tiến độ chấm bài",
            systemSetup: "Thiết lập hệ thống",
            target: "Mục tiêu:",
            action: "Hành động:",
            progress: "Tiến độ:",
            terminate: "Dừng chấm",
            initializing: "Đang khởi tạo phiên chấm...",
            compilingSubmission: "Đang biên dịch bài nộp...",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("ProgressWindow", () => {
  it("renders warmup indeterminate state when contestant and problem are empty", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ProgressWindow
          currentContestant=""
          currentProblem=""
          action="Initializing grading session..."
          percent={0}
          onTerminate={() => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Tiến độ chấm bài/);
    assert.match(html, /Thiết lập hệ thống/);
    assert.match(html, /Đang khởi tạo phiên chấm/);
    assert.match(html, /animate-pulse/);
    assert.match(html, /0%/);
    assert.match(html, /Dừng chấm/);
    assert.match(html, /tabular-nums/);
  });

  it("renders active progress state with contestant, problem, and percentage", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ProgressWindow
          currentContestant="NguyenVanA"
          currentProblem="BAI1"
          action="Compiling..."
          percent={45.6}
          onTerminate={() => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /NguyenVanA - BAI1/);
    assert.match(html, /Đang biên dịch bài nộp/);
    assert.match(html, /46%/);
    assert.match(html, /width:46%/);
  });
});
