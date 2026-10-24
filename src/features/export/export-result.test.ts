import assert from "node:assert/strict";
import test from "node:test";
import { viewerFailureOptions } from "./export-result.js";
import { parseScoreExportResult } from "../../../shared/score-export-wire.js";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import AppErrorToast from "../../components/AppErrorToast.js";
import { formatAppError } from "../errors/app-error.js";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";

test("saved workbook remains a recoverable export when its viewer fails", async () => {
  const result = parseScoreExportResult({ success: true, saved: true, path: "/tmp/export/Book.xlsx",
    diagnosticsPath: "/tmp/export/diagnostics.json", openStatus: "failed", openMode: null,
    openError: "viewer loader failed" });
  let copied = "";
  const options = viewerFailureOptions(result, ((key: string, values?: Record<string, string>) => (values?.defaultValue ?? key).replace("{{path}}", values?.path ?? "")), (path) => { copied = path; });
  assert.equal(options.code, "EXCEL_VIEWER_FAILED");
  assert.ok(options.action?.includes(result.path));
  options.onAction?.();
  assert.equal(copied, result.path);
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: {} } } });
  const markup = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n },
    React.createElement(AppErrorToast, { error: formatAppError(new Error(result.openError ?? ""), options), onClose() {} })));
  assert.match(markup, /Book.xlsx/);
  assert.match(markup, /Copy file path/);
  assert.match(markup, /role="alert"/);
});

test("malformed export replies cannot clear an export error", () => {
  assert.throws(() => parseScoreExportResult({ success: true, saved: false }), /Invalid/);
  assert.throws(() => parseScoreExportResult({ success: true, saved: true, path: "/tmp/a.xlsx", diagnosticsPath: "/tmp/a.json", openStatus: "opened" }), /Invalid/);
});
