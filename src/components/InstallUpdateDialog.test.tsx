import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import InstallUpdateDialog from "./InstallUpdateDialog.js";
import type { HostStatus } from "../types.js";

async function createI18n() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources: {
      vi: {
        translation: {
          common: { cancel: "Hủy" },
          updates: {
            restartNow: "Khởi động lại ngay",
            installTitle: "Cài đặt bản cập nhật",
            restartRequired: "Bản cập nhật đã tải xong. Cần khởi động lại để áp dụng.",
            installMessage: "Bạn có muốn cài đặt bản cập nhật ngay bây giờ?",
            installNow: "Cài đặt ngay",
            relaunchFailedHintWindows: "Vui lòng khởi động lại JudgeDesk thủ công.",
            relaunchFailedHintMac: "Vui lòng mở lại ứng dụng từ Applications.",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

const mockHostStatus: HostStatus = {
  gpp: { installed: true, version: "14.2.0" },
  python: { installed: true, version: "3.12" },
  tempDir: "C:\\Temp",
  platform: "win32",
  isServerMode: false,
  secureRunner: {
    mode: "windows-lpac-job",
    ready: true,
    executorVersion: "1.5.0",
    diagnostics: [],
    networkBlocked: true,
    filesystemIsolated: true,
    processTreeControlled: true,
    memoryLimitSupported: true,
  },
};

describe("InstallUpdateDialog", () => {
  it("renders nothing when show is false", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <InstallUpdateDialog
          show={false}
          updateRequiresRestart={false}
          updateRestartError=""
          isInstallingUpdate={false}
          hostStatus={mockHostStatus}
          onClose={() => {}}
          onRestart={async () => {}}
          onInstall={async () => {}}
        />
      </I18nextProvider>,
    );

    assert.equal(html, "");
  });

  it("renders restart prompt when updateRequiresRestart is true", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <InstallUpdateDialog
          show={true}
          updateRequiresRestart={true}
          updateRestartError=""
          isInstallingUpdate={false}
          hostStatus={mockHostStatus}
          onClose={() => {}}
          onRestart={async () => {}}
          onInstall={async () => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Khởi động lại ngay/);
    assert.match(html, /Bản cập nhật đã tải xong/);
  });

  it("renders install prompt and displays error when relaunch fails", async () => {
    const i18n = await createI18n();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <InstallUpdateDialog
          show={true}
          updateRequiresRestart={false}
          updateRestartError="failed to spawn updated process"
          isInstallingUpdate={false}
          hostStatus={mockHostStatus}
          onClose={() => {}}
          onRestart={async () => {}}
          onInstall={async () => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Cài đặt bản cập nhật/);
    assert.match(html, /Cài đặt ngay/);
    assert.match(html, /failed to spawn updated process/);
    assert.match(html, /Vui lòng khởi động lại JudgeDesk thủ công/);
  });
});
