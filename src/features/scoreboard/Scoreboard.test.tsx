import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import Scoreboard from "./Scoreboard.js";
import type { BatchJudgeResult } from "../../types.js";

const testI18n = createInstance();
void testI18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: {
    en: {
      translation: {
        scoreboard: {
          noContestants: "No contestants loaded yet",
          contestants: "Contestants",
          total: "Total",
          selectAllContestants: "Select all contestants",
          selectAllProblems: "Select all problems",
          selectProblem: "Select problem",
          actionsFor: "Actions for {{name}}",
          sortAlphabetically: "Sort alphabetically",
          notFound: "Not found",
        },
      },
    },
  },
});

describe("Scoreboard rendering stability", () => {
  const dummyFn = () => {};

  it("renders JE for both compiler setup and runtime judge errors instead of a numeric grade", () => {
    const result: BatchJudgeResult = { success: true, contestants: [{ contestantName: "Audit", problems: ["Setup", "Runtime"].map((problemName, index) => ({
      problemName, language: "cpp", compileStatus: index === 0 ? "JE" : "OK", testCases: [],
      summary: { total: 0, passed: 0, score: 0, maxScore: 1, status: "JE" },
    })) }] };
    const html = renderToStaticMarkup(<I18nextProvider i18n={testI18n}><Scoreboard allContestants={["Audit"]} contestants={["Audit"]}
      contestantSort="default" problems={["Setup", "Runtime"]} result={result} selectedContestants={{ Audit: true }}
      selectedProblems={{ Setup: true, Runtime: true }} interactionLocked={false} setContestantSort={dummyFn}
      setSelectedContestants={dummyFn} setSelectedProblems={dummyFn} onOpenActions={dummyFn} onOpenDetails={dummyFn} /></I18nextProvider>);
    assert.equal((html.match(/>JE<\/span>/g) || []).length, 3, "both cells and the incomplete total");
  });

  it("renders empty state when no contestants and no problems are loaded", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <Scoreboard
          allContestants={[]}
          contestants={[]}
          contestantSort="default"
          problems={[]}
          result={null}
          selectedContestants={{}}
          selectedProblems={{}}
          interactionLocked={false}
          setContestantSort={dummyFn}
          setSelectedContestants={dummyFn}
          setSelectedProblems={dummyFn}
          onOpenActions={dummyFn}
          onOpenDetails={dummyFn}
        />
      </I18nextProvider>,
    );

    assert.ok(html.includes("No contestants loaded yet"));
    assert.ok(!html.includes("<table"));
  });

  it("renders 18 contestants and 5 problems with stable responsive layout and truncated names", () => {
    const contestants = Array.from({ length: 18 }, (_, i) => `12000${String(34 + i).padStart(2, "0")}_Contestant_${i + 1}`);
    const problems = ["AID", "COINS", "GAME", "NUMBER", "SORT"];
    const selectedContestants = Object.fromEntries(contestants.map((c) => [c, true]));
    const selectedProblems = Object.fromEntries(problems.map((p) => [p, true]));

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <Scoreboard
          allContestants={contestants}
          contestants={contestants}
          contestantSort="default"
          problems={problems}
          result={null}
          selectedContestants={selectedContestants}
          selectedProblems={selectedProblems}
          interactionLocked={false}
          setContestantSort={dummyFn}
          setSelectedContestants={dummyFn}
          setSelectedProblems={dummyFn}
          onOpenActions={dummyFn}
          onOpenDetails={dummyFn}
        />
      </I18nextProvider>,
    );

    // Table must use w-full (100% width) to eliminate horizontal subpixel overflow
    assert.ok(html.includes("w-full"), "table must have w-full class");
    assert.ok(html.includes("table-layout:fixed"), "table must use fixed table layout");
    assert.ok(html.includes("min-width:"), "table must specify min-width");

    // All 18 contestants must be rendered with 34px row height and truncate class
    for (const name of contestants) {
      assert.ok(html.includes(name), `HTML should contain ${name}`);
      assert.ok(html.includes(`title="${name}"`), `HTML should have title tooltip for ${name}`);
    }
    assert.ok(html.includes("truncate font-mono text-xs"), "Contestant name must have truncate class to prevent height expansion");
    assert.ok(html.includes("height:34px"), "Row must have fixed 34px height");

    // All 5 problem headers must be rendered
    for (const prob of problems) {
      assert.ok(html.includes(prob), `HTML should contain problem header ${prob}`);
    }
  });

  it("handles wide contests with 25 problems gracefully by applying minimum problem column widths", () => {
    const contestants = ["Alice", "Bob"];
    const problems = Array.from({ length: 25 }, (_, i) => `PROB_${i + 1}`);
    const selectedContestants = { Alice: true, Bob: true };
    const selectedProblems = Object.fromEntries(problems.map((p) => [p, true]));

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <Scoreboard
          allContestants={contestants}
          contestants={contestants}
          contestantSort="default"
          problems={problems}
          result={null}
          selectedContestants={selectedContestants}
          selectedProblems={selectedProblems}
          interactionLocked={false}
          setContestantSort={dummyFn}
          setSelectedContestants={dummyFn}
          setSelectedProblems={dummyFn}
          onOpenActions={dummyFn}
          onOpenDetails={dummyFn}
        />
      </I18nextProvider>,
    );

    // With 25 problems, minTableWidth exceeds containerWidth, so problem cols get width: 72px
    assert.ok(html.includes("width:72px"), "Problem cols must have min width 72px when overflowing");
    assert.ok(html.includes("w-full"));
  });
});
