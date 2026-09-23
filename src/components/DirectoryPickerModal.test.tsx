import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import DirectoryPickerModal from "./DirectoryPickerModal.js";

async function createI18n() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources: {
      vi: {
        translation: {
          common: { close: "Đóng", cancel: "Hủy" },
          directoryPicker: {
            selectTests: "Chọn thư mục bộ test",
            selectContestants: "Chọn thư mục thí sinh",
            testsPlaceholder: "Đường dẫn tới thư mục Tests...",
            contestantsPlaceholder: "Đường dẫn tới thư mục Contestants...",
            browse: "Duyệt...",
            dropTarget: "Kéo thả thư mục vào đây",
            dropTestsHint: "Thả thư mục chứa các bài thi và testcases vào đây",
            dropContestantsHint: "Thả thư mục chứa mã nguồn của các thí sinh vào đây",
            load: "Nạp dữ liệu",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("DirectoryPickerModal", () => {
  it("renders tests configuration mode correctly", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DirectoryPickerModal
          kind="tests"
          path="D:/Contest/Tests"
          onPathChange={() => {}}
          onDropPath={() => {}}
          onClose={() => {}}
          onLoad={() => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Chọn thư mục bộ test/);
    assert.match(html, /D:\/Contest\/Tests/);
    assert.match(html, /Đường dẫn tới thư mục Tests/);
    assert.match(html, /Thả thư mục chứa các bài thi và testcases/);
    assert.match(html, /Duyệt\.\.\./);
    assert.match(html, /Nạp dữ liệu/);
  });

  it("renders contestants configuration mode correctly", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DirectoryPickerModal
          kind="contestants"
          path=""
          onPathChange={() => {}}
          onDropPath={() => {}}
          onClose={() => {}}
          onLoad={() => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Chọn thư mục thí sinh/);
    assert.match(html, /Đường dẫn tới thư mục Contestants/);
    assert.match(html, /Thả thư mục chứa mã nguồn của các thí sinh/);
  });
});
