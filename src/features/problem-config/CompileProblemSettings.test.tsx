import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProblemCompileConfig, ProblemConfig } from "../../types.js";
import enTranslations from "../../locales/en.json";
import viTranslations from "../../locales/vi.json";
import {
  CompileProblemSettings,
  compileConfigForProfile,
  formatCompileFlags,
  localizedCompileValidationMessage,
  parseCustomCompileDraft,
  withProblemCompileConfig,
} from "./CompileProblemSettings.js";

async function renderSettings(
  language: "en" | "vi",
  value?: ProblemCompileConfig,
): Promise<string> {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources: {
      en: { translation: enTranslations },
      vi: { translation: viTranslations },
    },
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <CompileProblemSettings value={value} onChange={() => {}} />
    </I18nextProvider>,
  );
}

describe("per-problem compile settings", () => {
  it("shows legacy problems as Themis compatibility with separate C++ and C snapshots", async () => {
    const markup = await renderSettings("vi");

    assert.match(markup, /Biên dịch/);
    assert.match(markup, /Tương thích Themis/);
    assert.match(markup, /<option value="themis" selected="">Tương thích Themis<\/option>/);
    assert.match(markup, /Hiện đại \(tham khảo IOI\/ICPC 2025\)/);
    assert.match(markup, /ICPC World Finals/);
    assert.match(markup, /Tùy chỉnh/);
    assert.match(markup, /Tham số C\+\+/);
    assert.match(markup, /Tham số C</);
    assert.match(markup, /-std=c\+\+14/);
    assert.match(markup, /-std=c11/);
    assert.match(markup, /Config\.cfg/);
    assert.match(markup, /không làm đổi trình chấm \(checker\) đã chọn/);
  });

  it("materializes each preset as a complete per-problem snapshot", () => {
    const modern = compileConfigForProfile(undefined, "modern_ioi_icpc_2025");
    const icpc = compileConfigForProfile(modern, "icpc_world_finals");

    assert.deepEqual(modern, {
      schemaVersion: 1,
      profile: "modern_ioi_icpc_2025",
      flags: {
        cpp: ["-std=gnu++20", "-O2", "-pipe"],
        c: ["-std=gnu17", "-O2", "-pipe"],
      },
    });
    assert.deepEqual(icpc, {
      schemaVersion: 1,
      profile: "icpc_world_finals",
      flags: {
        cpp: ["-std=gnu++20", "-O2", "-g"],
        c: ["-std=gnu11", "-O2", "-g"],
      },
    });
  });

  it("renders English labels and editable C++/C argv fields for Custom", async () => {
    const custom = parseCustomCompileDraft("-std=gnu++20 -O2", "-std=gnu11 -O2").config;
    assert.ok(custom);
    const markup = await renderSettings("en", custom);

    assert.match(markup, /Compilation/);
    assert.match(markup, /Themis compatibility/);
    assert.match(markup, /Modern \(IOI\/ICPC 2025 reference\)/);
    assert.match(markup, /Custom/);
    assert.match(markup, /id="problem-compile-cpp"/);
    assert.match(markup, /id="problem-compile-c"/);
    assert.match(markup, /Parsed as argv/);
    assert.match(markup, /Changing it does not change the selected checker/);
  });

  it("parses custom text into argv without a shell and rejects protected output arguments", () => {
    const valid = parseCustomCompileDraft(
      '-std=gnu++20 -O2 "-DNAME=two words"',
      "-std=gnu11 -O2",
    );
    assert.deepEqual(valid.config?.flags.cpp, [
      "-std=gnu++20",
      "-O2",
      "-DNAME=two words",
    ]);
    assert.deepEqual(valid.config?.flags.c, ["-std=gnu11", "-O2"]);

    const invalid = parseCustomCompileDraft("-O2 -o submission.exe", "-O2");
    assert.equal(invalid.config, null);
    assert.match(invalid.errors.cpp || "", /protected compilation mode or output/);
  });

  it("localizes structured custom-flag failures instead of leaking English internals", async () => {
    const invalid = parseCustomCompileDraft("-O2 -o submission.exe", "-O2");
    const detail = invalid.errorDetails.cpp;
    assert.ok(detail);
    assert.equal(detail.reason, "compileModeOverride");

    const i18n = createInstance();
    await i18n.init({
      lng: "vi",
      resources: { vi: { translation: viTranslations } },
      interpolation: { escapeValue: false },
    });
    const localized = localizedCompileValidationMessage(
      detail,
      invalid.errors.cpp || "",
      i18n.t,
    );
    assert.match(localized, /Tham số số 2 \(-o\)/);
    assert.match(localized, /ghi đè chế độ biên dịch/);
    assert.doesNotMatch(localized, /would override/);
  });

  it("formats stored argv so quoted values round-trip safely", () => {
    const flags = ["-O2", "-DNAME=two words", '-DQUOTE="value"', "-DPATH=C:\\Contest Files"];
    const text = formatCompileFlags(flags);
    const parsed = parseCustomCompileDraft(text, "-O2");

    assert.deepEqual(parsed.config?.flags.cpp, flags);
  });

  it("updates compile settings without replacing the selected checker", () => {
    const original: ProblemConfig = {
      useStdIO: false,
      totalScore: 100,
      defaultScore: 1,
      testScores: {},
      checkerType: "Custom_Checker.cpp",
    };
    const compile = compileConfigForProfile(undefined, "modern_ioi_icpc_2025");
    const updated = withProblemCompileConfig(original, compile);

    assert.equal(updated.checkerType, "Custom_Checker.cpp");
    assert.equal(updated.totalScore, 100);
    assert.deepEqual(updated.compile, compile);
  });

  it("includes the normalized compile snapshot in the existing Config.cfg save payload", () => {
    const source = readFileSync(new URL("./useProblemConfigEditor.ts", import.meta.url), "utf8");

    assert.match(
      source,
      /const configToSave = \{[\s\S]*compile: normalizeCompileConfig\(config\.compile\),[\s\S]*body: JSON\.stringify\(\{ path: problemDirPath, config: configToSave \}\)/,
    );
    assert.match(source, /checkerType: config\.checkerType \|\| "C1"/);
  });
});
