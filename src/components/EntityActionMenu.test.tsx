import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import EntityActionMenu from "./EntityActionMenu.js";
import type { ScoreboardActionTarget } from "../features/scoreboard/Scoreboard.js";

async function createI18n() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "vi",
    resources: {
      vi: {
        translation: {
          actions: {
            closeMenu: "Đóng menu",
            configProblem: "Cấu hình bài thi",
            deleteScore: "Xóa kết quả",
            details: "Xem chi tiết chấm",
            regrade: "Chấm lại",
            noResults: "Chưa có kết quả để thao tác",
            unavailableWhileBusy: "Không thể thao tác khi đang chấm bài",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("EntityActionMenu", () => {
  it("renders problem menu with config option and active actions", async () => {
    const i18n = await createI18n();
    const target: ScoreboardActionTarget = {
      type: "problem",
      name: "BAI1",
      x: 100,
      y: 200,
      hasResults: true,
      canRegrade: true,
    };

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <EntityActionMenu
          target={target}
          mutationsLocked={false}
          onClose={() => {}}
          onConfig={() => {}}
          onDelete={() => {}}
          onDetails={() => {}}
          onRegrade={() => {}}
        />
      </I18nextProvider>,
    );

    assert.match(html, /Cấu hình bài thi/);
    assert.match(html, /Xóa kết quả/);
    assert.match(html, /Chấm lại/);
    assert.match(html, /left:100px;top:200px/);
  });

  it("renders contestant menu without problem config option and disabled actions when no results", async () => {
    const i18n = await createI18n();
    const target: ScoreboardActionTarget = {
      type: "contestant",
      name: "NguyenVanA",
      x: 50,
      y: 80,
      hasResults: false,
      canRegrade: false,
    };

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <EntityActionMenu
          target={target}
          mutationsLocked={false}
          onClose={() => {}}
          onConfig={() => {}}
          onDelete={() => {}}
          onDetails={() => {}}
          onRegrade={() => {}}
        />
      </I18nextProvider>,
    );

    assert.doesNotMatch(html, /Cấu hình bài thi/);
    assert.match(html, /Xóa kết quả/);
    assert.match(html, /disabled/);
    assert.match(html, /Chưa có kết quả để thao tác/);
  });
});
