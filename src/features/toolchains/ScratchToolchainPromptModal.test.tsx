import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import ScratchToolchainPromptModal from "./ScratchToolchainPromptModal.js";

async function createI18n() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources: {
      vi: {
        translation: {
          common: { close: "Đóng" },
          toolchains: {
            scratchPrompt: {
              title: "Tính năng mới: Chấm bài thi Scratch",
              subtitle: "Hỗ trợ chấm trực tiếp các bài thi Scratch (.sb3, .sb2) cho kỳ thi Tin học trẻ",
              featuresTitle: "Các điểm nổi bật của Bộ chấm Scratch",
              featureFormats: "Định dạng hỗ trợ:",
              featureEngine: "Engine thực thi:",
              featureIO: "Cơ chế vào ra:",
              featurePlatform: "Đa nền tảng:",
              note: "Bạn có thể thay đổi cấu hình hoặc kích hoạt lại ngôn ngữ Scratch bất cứ lúc nào trong Quản lý trình biên dịch (phím tắt F6).",
              dismissAction: "Để sau",
              confirmAction: "Kích hoạt ngay",
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("ScratchToolchainPromptModal", () => {
  it("renders nothing when isOpen is false", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ScratchToolchainPromptModal
          isOpen={false}
          onClose={() => {}}
          onEnableScratch={async () => {}}
          onSuccessToast={() => {}}
        />
      </I18nextProvider>,
    );

    assert.equal(html, "");
  });

  it("renders modal content, version badge, and feature highlights when open", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ScratchToolchainPromptModal
          isOpen={true}
          onClose={() => {}}
          onEnableScratch={async () => {}}
          onSuccessToast={() => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Tính năng mới: Chấm bài thi Scratch/);
    assert.match(html, /Các điểm nổi bật của Bộ chấm Scratch/);
    assert.match(html, /Scratch 3\.0/);
    assert.match(html, /Kích hoạt ngay/);
    assert.match(html, /Để sau/);
    assert.match(html, /role="dialog"/);
  });
});
