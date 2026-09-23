import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import ProblemConfigSaveConfirmDialog from "./ProblemConfigSaveConfirmDialog.js";

async function createI18n() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources: {
      vi: {
        translation: {
          common: { cancel: "Hủy" },
          problemConfig: {
            confirmSaveTitle: "Xác nhận lưu cấu hình bài thi",
            confirmSaveMessage: "Lưu cấu hình cho bài {{problem}} sẽ xóa kết quả chấm trước đó.",
            saveAndClear: "Xác nhận & Lưu",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("ProblemConfigSaveConfirmDialog", () => {
  it("renders warning dialog with problem name and actions", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ProblemConfigSaveConfirmDialog
          problemName="FIBONACCI"
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Xác nhận lưu cấu hình bài thi/);
    assert.match(html, /Lưu cấu hình cho bài FIBONACCI/);
    assert.match(html, /Xác nhận &amp; Lưu|Xác nhận & Lưu/);
    assert.match(html, /Hủy/);
    assert.match(html, /role="alertdialog"/);
  });
});
