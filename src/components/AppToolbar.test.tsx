import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppUpdateState } from "../features/updates/useAppUpdater.js";
import type { ContestantSortMode } from "../features/scoreboard/scoreboard-model.js";
import { DonationButton, HelpButton, ScoreSortButton, UpdateActionButton, UpdateButton } from "./AppToolbar.js";

const resources = {
  en: {
    translation: {
      updates: {
        check: "Check for updates",
        checking: "Checking...",
        available: "Version {{version}} available",
        downloading: "Downloading {{percent}}%",
        installQuestion: "Install update",
        restartToUpdate: "Restart to update",
        upToDate: "Up to date",
        checkFailed: "Update check failed",
        downloadFailed: "Update download failed",
        installFailed: "Update installation failed",
        retry: "Try again",
      },
      helpCenter: { open: "Help" },
      donation: { tooltip: "Buy me a coffee?" },
      scoreboard: {
        sortScores: "Sort scores",
        sortScoreDesc: "Score: High → Low",
        sortScoreAsc: "Score: Low → High",
        sortScoreDisabledHint: "Requires at least one score to sort",
        sortScoreDefaultHint: "Sort: Highest to lowest score",
        sortScoreDescHint: "Sorted: High to low. Click to sort: Low to high",
        sortScoreAscHint: "Sorted: Low to high. Click to reset to initial order (A-Z)",
      },
    },
  },
  vi: {
    translation: {
      updates: {
        check: "Kiểm tra cập nhật",
        checking: "Đang kiểm tra...",
        available: "Có bản {{version}}",
        downloading: "Đang tải {{percent}}%",
        installQuestion: "Cài bản cập nhật",
        restartToUpdate: "Khởi động lại để cập nhật",
        upToDate: "Đã là bản mới nhất",
        checkFailed: "Kiểm tra cập nhật thất bại",
        downloadFailed: "Tải bản cập nhật thất bại",
        installFailed: "Cài đặt bản cập nhật thất bại",
        retry: "Thử lại",
      },
      helpCenter: { open: "Hướng dẫn" },
      donation: { tooltip: "Buy me a coffee? (Ủng hộ dự án?)" },
      scoreboard: {
        sortScores: "Sắp xếp điểm",
        sortScoreDesc: "Điểm: Cao → Thấp",
        sortScoreAsc: "Điểm: Thấp → Cao",
        sortScoreDisabledHint: "Cần có ít nhất 1 điểm để sắp xếp",
        sortScoreDefaultHint: "Sắp xếp: Điểm cao xuống thấp",
        sortScoreDescHint: "Đang xếp: Điểm cao → thấp. Bấm để xếp: Điểm thấp → cao",
        sortScoreAscHint: "Đang xếp: Điểm thấp → cao. Bấm để về ban đầu (A-Z)",
      },
    },
  },
};

async function renderUpdateActionButton(state: AppUpdateState, language: "en" | "vi") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources,
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UpdateActionButton
        state={state}
        disabled={false}
        onInstall={() => {}}
      />
    </I18nextProvider>,
  );
}

async function renderUpdateButton(state: AppUpdateState, language: "en" | "vi") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources,
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UpdateButton
        state={state}
        disabled={false}
        onCheck={() => {}}
        onChoose={() => {}}
        onInstall={() => {}}
      />
    </I18nextProvider>,
  );
}

async function renderHelpButton(language: "en" | "vi") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources,
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <HelpButton onOpen={() => {}} />
    </I18nextProvider>,
  );
}

async function renderScoreSortButton(
  canSort: boolean,
  sortMode: ContestantSortMode,
  language: "en" | "vi",
  disabled = !canSort,
) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    resources,
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ScoreSortButton
        canSort={canSort}
        disabled={disabled}
        sortMode={sortMode}
        onToggle={() => {}}
      />
    </I18nextProvider>,
  );
}

describe("toolbar update action button", () => {
  it("renders nothing when idle, checking, current, or on error", async () => {
    assert.equal(await renderUpdateActionButton({ status: "idle" }, "en"), "");
    assert.equal(await renderUpdateActionButton({ status: "checking" }, "en"), "");
    assert.equal(await renderUpdateActionButton({ status: "current" }, "en"), "");
    assert.equal(
      await renderUpdateActionButton(
        { status: "error", phase: "check", message: "network" },
        "en",
      ),
      "",
    );
  });

  it("shows a blue button with progress while downloading", async () => {
    const markup = await renderUpdateActionButton(
      { status: "downloading", version: "1.4.47", edition: "core", percent: 68 },
      "vi",
    );

    assert.match(markup, /bg-blue-600/);
    assert.match(markup, /disabled=""/);
    assert.match(markup, /animate-spin/);
    assert.match(markup, />Đang tải 68%</);
  });

  it("shows a blue button to restart to update when downloaded", async () => {
    const markup = await renderUpdateActionButton(
      { status: "downloaded", version: "1.4.47", edition: "core" },
      "en",
    );

    assert.match(markup, /bg-blue-600/);
    assert.match(markup, />→ Restart to update</);
  });
});

describe("toolbar brand logo button", () => {
  it("renders logo image without browser tooltip title attribute", () => {
    const source = readFileSync(new URL("./AppToolbar.tsx", import.meta.url), "utf8");
    assert.match(source, /<img src=\{logoImg\} alt="JudgeDesk"/);
    assert.match(source, />JudgeDesk<\/span>/);
    assert.match(source, /brandMenuOpen &&/);
    assert.match(source, />\s*JudgeDesk v\{APP_VERSION\}\s*</);
    assert.match(source, /t\("updates\.check"\)/);
  });

  it("disables manual check button and displays checking label when checking or downloading", () => {
    const source = readFileSync(new URL("./AppToolbar.tsx", import.meta.url), "utf8");
    assert.match(
      source,
      /disabled=\{updateState\.status === "checking" \|\| updateState\.status === "downloading"\}/,
    );
    assert.match(
      source,
      /updateState\.status === "checking" \? t\("updates\.checking"\) : t\("updates\.check"\)/,
    );
  });
});

describe("toolbar donation button", () => {
  it("shows the requested Vietnamese coffee tooltip", async () => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: "vi",
      resources,
      interpolation: { escapeValue: false },
    });
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DonationButton onOpen={() => {}} disabled={false} />
      </I18nextProvider>,
    );
    assert.match(markup, /title="Buy me a coffee\? \(Ủng hộ dự án\?\)"/);
  });

  it("keeps Coffee between Help and Tools", () => {
    const source = readFileSync(new URL("./AppToolbar.tsx", import.meta.url), "utf8");
    assert.match(source, /<HelpButton[\s\S]*?<DonationButton[\s\S]*?<div ref=\{utilityMenuRef\}/);
  });
});

describe("toolbar help button", () => {
  it("uses a visible English label and advertises the F1 shortcut", async () => {
    const markup = await renderHelpButton("en");

    assert.match(markup, />Help</);
    assert.match(markup, /aria-keyshortcuts="F1"/);
    assert.match(markup, /aria-label="Help \(F1\)"/);
    assert.match(markup, /h-10/);
  });

  it("uses an explicit Vietnamese label", async () => {
    const markup = await renderHelpButton("vi");

    assert.match(markup, />Hướng dẫn</);
    assert.match(markup, /aria-label="Hướng dẫn \(F1\)"/);
  });

  it("keeps Update action indicator immediately before Help in the toolbar", () => {
    const source = readFileSync(new URL("./AppToolbar.tsx", import.meta.url), "utf8");

    assert.match(source, /<UpdateActionButton[\s\S]*?<HelpButton onOpen=\{onOpenHelp\} \/>/);
  });

  it("does not render an inline error box in the toolbar to prevent horizontal overflow", () => {
    const source = readFileSync(new URL("./AppToolbar.tsx", import.meta.url), "utf8");

    assert.doesNotMatch(source, /errorMessage/);
    assert.doesNotMatch(source, /border-rose-300 bg-rose-50/);
  });
});

describe("toolbar score sort button", () => {
  it("is disabled with helpful Vietnamese tooltip when no scores exist", async () => {
    const markup = await renderScoreSortButton(false, "default", "vi");

    assert.match(markup, /disabled=""/);
    assert.match(markup, /title="Cần có ít nhất 1 điểm để sắp xếp"/);
    assert.match(markup, />Sắp xếp điểm</);
  });

  it("is disabled with helpful English tooltip when no scores exist", async () => {
    const markup = await renderScoreSortButton(false, "default", "en");

    assert.match(markup, /disabled=""/);
    assert.match(markup, /title="Requires at least one score to sort"/);
    assert.match(markup, />Sort scores</);
  });

  it("is enabled when scores exist and indicates default high-to-low sort on hover", async () => {
    const markup = await renderScoreSortButton(true, "default", "vi");

    assert.doesNotMatch(markup, /disabled=""/);
    assert.match(markup, /title="Sắp xếp: Điểm cao xuống thấp"/);
    assert.match(markup, />Sắp xếp điểm</);
  });

  it("shows active high-to-low state (click 1) with hint for next click", async () => {
    const markup = await renderScoreSortButton(true, "score_desc", "vi");

    assert.match(markup, />Điểm: Cao → Thấp</);
    assert.match(markup, /title="Đang xếp: Điểm cao → thấp\. Bấm để xếp: Điểm thấp → cao"/);
    assert.match(markup, /border-indigo-400 bg-indigo-50/);
  });

  it("shows active low-to-high state (click 2) with hint to reset", async () => {
    const markup = await renderScoreSortButton(true, "score_asc", "vi");

    assert.match(markup, />Điểm: Thấp → Cao</);
    assert.match(markup, /title="Đang xếp: Điểm thấp → cao\. Bấm để về ban đầu \(A-Z\)"/);
    assert.match(markup, /border-indigo-400 bg-indigo-50/);
  });

  it("omits ScoreSortButton from main toolbar JSX to keep toolbar compact", () => {
    const source = readFileSync(new URL("./AppToolbar.tsx", import.meta.url), "utf8");

    assert.doesNotMatch(source, /<ScoreSortButton[\s\S]*?<button\s+type="button"\s+onClick=\{onDeleteSelected\}/);
  });
});
