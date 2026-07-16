import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

async function renderWithTranslations(element: ReactNode) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: {
      en: {
        translation: {
          toolchains: {
            managerTitle: "Compilers & Runtimes Manager",
            close: "Close Manager",
            loadingState: "Loading compiler configurations...",
            loadingHint: "Custom paths remain available while loading.",
            cppSettings: "C/C++ Compiler Settings",
            pythonSettings: "Python Interpreter Settings",
          },
          problemConfig: { save: "Save" },
          toolbar: { statusMenu: { title: "Tools", checking: "Checking..." } },
          common: { close: "Close" },
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{element}</I18nextProvider>,
  );
}

describe("toolchain settings UI regressions", () => {
  it("keeps the Manager action visible before host detection completes", async () => {
    Object.assign(globalThis, {
      window: { location: { origin: "http://localhost:5173" } },
    });
    const { HostStatusMenu } = await import("../../components/AppToolbar.js");
    const markup = await renderWithTranslations(
      <HostStatusMenu status={null} onClose={() => {}} onOpenToolchains={() => {}} />,
    );

    assert.match(markup, /Checking\.\.\./);
    assert.match(markup, /Compilers &amp; Runtimes Manager/);
  });

  it("keeps manual compiler paths editable while detection is loading", async () => {
    Object.assign(globalThis, {
      window: { location: { origin: "http://localhost:5173" } },
    });
    const { default: ToolchainManager } = await import("./ToolchainManager.js");
    const markup = await renderWithTranslations(
      <ToolchainManager onClose={() => {}} />,
    );

    assert.equal((markup.match(/<input/g) || []).length, 2);
    assert.match(markup, /g\+\+ \/ clang\+\+/);
    assert.match(markup, /python \/ python3/);
  });

  it("does not reload remembered problems when toolchain dialogs close", () => {
    const appSource = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );
    const modalStart = appSource.indexOf("{openToolchains &&");
    const modalEnd = appSource.indexOf("{showInstallUpdate &&", modalStart);
    assert.notEqual(modalStart, -1);
    assert.notEqual(modalEnd, -1);
    assert.doesNotMatch(
      appSource.slice(modalStart, modalEnd),
      /handleFetchProblems/,
    );
  });
});
