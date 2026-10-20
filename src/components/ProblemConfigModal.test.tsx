import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import ProblemConfigModal from "./ProblemConfigModal.js";
import vi from "../locales/vi.json";
import en from "../locales/en.json";

for (const language of ["vi", "en"] as const) {
  it(`renders accessible navigation and preloaded compilation in ${language}`, async () => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({ lng: language, resources: { vi: { translation: vi }, en: { translation: en } } });
    const markup = renderToStaticMarkup(<I18nextProvider i18n={i18n}><ProblemConfigModal
      problemName="A_plus_B" testPath="fixture" initialConfig={{ totalScore: 0, defaultScore: 1, testScores: {}, useStdIO: true }}
      onClose={() => undefined} onSave={() => undefined} saveDisabled
    /></I18nextProvider>);
    assert.match(markup, /role="dialog" aria-modal="true"/);
    assert.equal((markup.match(/role="tab"/g) ?? []).length, 3);
    assert.equal((markup.match(/role="tabpanel"/g) ?? []).length, 3);
    assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1);
    assert.match(markup, />Tests<\/button>/);
    assert.match(markup, /Test well-formed/);
    assert.match(markup, language === "vi" ? /Nhóm test/ : /Enable groups/);
    assert.match(markup, language === "vi" ? /Hiện nội dung/ : /Show content/);
    assert.match(markup, /id="problem-compile-settings-title"/);
    assert.match(markup, language === "vi" ? /Tổng điểm 0/ : /Total score 0/);
    assert.match(markup, /role="status"/);
    assert.match(markup, language === "vi" ? /không thể lưu/ : /cannot be saved/);
  });
}

it("yields Escape key handling to nested checker source preview modal without closing parent config modal", () => {
  const modalSource = readFileSync(new URL("./ProblemConfigModal.tsx", import.meta.url), "utf8");
  const basicSource = readFileSync(
    new URL("../features/problem-config/BasicProblemSettings.tsx", import.meta.url),
    "utf8",
  );
  assert.match(modalSource, /topDialog\?\.dataset\.nestedModal/);
  assert.match(modalSource, /querySelector\("\[data-nested-modal\]"\)/);
  assert.match(basicSource, /data-nested-modal="checker-source-preview"/);
});
