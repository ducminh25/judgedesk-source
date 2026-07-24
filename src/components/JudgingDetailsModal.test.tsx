import assert from "node:assert/strict";
import test from "node:test";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import JudgingDetailsModal from "./JudgingDetailsModal.js";
import type { ProblemResult } from "../types.js";

test("judging details show useful WA context but hide internal execution diagnostics", async () => {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: {
      en: {
        translation: {
          common: { close: "Close", noOutput: "No output" },
          judgingDetails: {
            title: "Judging details",
            problem: "Problem",
            overall: "Overall",
            score: "Score",
            passedTests: "Tests passed",
            compiledSuccessfully: "Compiled successfully in",
            checker: "Checker",
            expectedOutput: "Expected output",
            contestantOutput: "Contestant output",
            seconds: "s",
            filters: {
              all: "All",
              correct: "Correct",
              incorrect: "Incorrect",
              partial: "Partial",
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  const data = {
    problemName: "A_plus_B",
    language: "cpp",
    compileStatus: "OK",
    compileError: "",
    compileTime: 1175.63,
    testCases: [{
      name: "test01",
      status: "MLE",
      executionTime: 3,
      peakMemory: 1147.06 * 1024,
      score: 0,
      errorDetail: "0xC00000FD INTERNAL_ERROR_DETAIL",
      execution: {
        reason: "memory_limit",
        exitCode: -1073741571,
        signalOrStatus: "0xC00000FD",
        securitySetupTimeUs: 200_000,
        wallTimeUs: 3_000,
        resultCollectionTimeUs: 100,
        stdoutBytes: 0,
        stderrBytes: 0,
        effectiveMemoryLimitBytes: 512 * 1024 * 1024,
      },
    }, {
      name: "test02",
      status: "WA",
      executionTime: 25,
      peakMemory: 2048,
      score: 0,
      checkerMessage: "Tokens differ at position 2",
      errorDetail: "INTERNAL_WA_ERROR_DETAIL",
      expectedOutputPreview: "42",
      actualOutputPreview: "41",
    }],
    summary: {
      total: 2,
      passed: 0,
      maxScore: 2,
      score: 0,
      status: "MLE",
    },
  } satisfies ProblemResult;

  const markup = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <JudgingDetailsModal
        data={data}
        contestantName="MLE_cpp"
        onClose={() => {}}
      />
    </I18nextProvider>,
  );

  assert.match(markup, /test01/);
  assert.match(markup, /0\.0030s/);
  assert.match(markup, /1147\.06 MB/);
  assert.match(markup, /test02/);
  assert.match(markup, /0\.0250s/);
  assert.match(markup, /2\.00 MB/);
  assert.match(markup, /Tokens differ at position 2/);
  assert.match(markup, /Expected output/);
  assert.match(markup, />42</);
  assert.match(markup, /Contestant output/);
  assert.match(markup, />41</);
  assert.match(markup, /MLE/);
  assert.doesNotMatch(
    markup,
    /memory_limit|0xC00000FD|-1073741571|INTERNAL_ERROR|INTERNAL_WA_ERROR/,
  );
});
