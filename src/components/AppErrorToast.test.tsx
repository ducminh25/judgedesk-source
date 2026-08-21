import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import AppErrorToast from "./AppErrorToast.js";
import type { AppError } from "../features/errors/app-error.js";

async function renderToast(error: AppError | null, onClose = () => {}) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources: {
      vi: {
        translation: {
          common: { close: "Đóng" },
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AppErrorToast error={error} onClose={onClose} />
    </I18nextProvider>,
  );
}

describe("AppErrorToast", () => {
  it("renders nothing when error is null", async () => {
    const html = await renderToast(null);
    assert.equal(html, "");
  });

  it("renders 3-part structured error with title, reason, action", async () => {
    const error: AppError = {
      title: "Không thể xuất file Excel",
      reason: "File Excel đang được mở trong phần mềm khác.",
      action: "Hãy đóng file Excel và bấm Xuất lại.",
      severity: "error",
    };

    const html = await renderToast(error);

    assert.match(html, /Không thể xuất file Excel/);
    assert.match(html, /File Excel đang được mở/);
    assert.match(html, /Hãy đóng file Excel/);
    assert.match(html, /role="alert"/);
  });

  it("renders action button when actionLabel is provided", async () => {
    const error: AppError = {
      title: "Chưa nạp thí sinh",
      reason: "Thư mục thí sinh đang trống.",
      action: "Bấm nút bên dưới để chọn thư mục.",
      actionLabel: "Nạp Thí Sinh",
      onAction: () => {},
      severity: "warning",
    };

    const html = await renderToast(error);

    assert.match(html, /Nạp Thí Sinh/);
  });
});
