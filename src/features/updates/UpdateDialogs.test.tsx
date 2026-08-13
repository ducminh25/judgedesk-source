import assert from "node:assert/strict";
import test from "node:test";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import {
  DonationConfirmDialog,
  UpdateEditionChangeDialog,
  UpdateEditionDialog,
} from "./UpdateDialogs.js";

const translations = {
  common: { cancel: "Hủy" },
  updates: {
    chooseTitle: "Chọn bản JudgeDesk {{version}}",
    chooseMessage: "Chọn bản phù hợp",
    currentEdition: "Đang dùng",
    recommended: "Khuyên dùng",
    downloadSize: "Dung lượng tải về",
    installedSize: "Dung lượng sau khi cài",
    downloadCleanupHint: "Đóng app sẽ bỏ gói đã tải",
    confirmDownload: "Xác nhận và tải về",
    editions: {
      core: { name: "Core", description: "Bản Core" },
      full: { name: "Full", description: "Bản Full" },
    },
    editionChange: {
      coreToFull: { title: "Chuyển từ Core sang Full?", message: "Cài toolchain Full" },
      fullToCore: { title: "Chuyển từ Full sang Core?", message: "Gỡ toolchain tích hợp" },
    },
  },
  donation: {
    openTitle: "Mở trang hiển thị QR?",
    openMessage: "Mở trong trình duyệt",
    openAction: "Mở trang QR",
  },
};

const candidates = {
  core: {
    edition: "core" as const,
    version: "1.3.4",
    target: "windows-x86_64-core",
    downloadSizeBytes: 40 * 1024 ** 2,
    installedSizeBytes: 110 * 1024 ** 2,
  },
  full: {
    edition: "full" as const,
    version: "1.3.4",
    target: "windows-x86_64-full",
    downloadSizeBytes: 800 * 1024 ** 2,
    installedSizeBytes: 1.9 * 1024 ** 3,
  },
};

async function render(node: ReactNode) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources: { vi: { translation: translations } },
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

test("edition chooser shows both choices, the current badge, and bundle sizes", async () => {
  const markup = await render(
    <UpdateEditionDialog
      version="1.3.4"
      currentEdition="core"
      candidates={candidates}
      onCancel={() => {}}
      onChoose={() => {}}
    />,
  );
  assert.match(markup, /Core/);
  assert.match(markup, /Full/);
  assert.match(markup, /Đang dùng/);
  assert.match(markup, /40 MB/);
  assert.match(markup, /1,9 GB/);
  assert.match(markup, /Đóng app sẽ bỏ gói đã tải/);
});

test("edition change confirmation explains the selected direction before download", async () => {
  const markup = await render(
    <UpdateEditionChangeDialog
      currentEdition="core"
      candidate={candidates.full}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  assert.match(markup, /Chuyển từ Core sang Full/);
  assert.match(markup, /Cài toolchain Full/);
  assert.match(markup, /Xác nhận và tải về/);
});

test("donation confirmation asks before opening the QR page", async () => {
  const markup = await render(
    <DonationConfirmDialog onCancel={() => {}} onConfirm={() => {}} />,
  );
  assert.match(markup, /Mở trang hiển thị QR/);
  assert.match(markup, /Mở trang QR/);
});
