import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { registerExportRoutes } from "../routes/export-routes.js";
import { encodeScoreExportPayload, parseScoreExportResult, SCORE_EXPORT_CONTENT_TYPE } from "../../shared/score-export-wire.js";

test("Node export preserves the workbook and diagnostics when its viewer cannot start", async () => {
  const app = express();
  let workbookPath = "";
  registerExportRoutes(app, async (file) => { workbookPath = file; throw new Error("viewer loader failed"); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/open-excel`, {
      method: "POST", headers: { "Content-Type": SCORE_EXPORT_CONTENT_TYPE },
      body: encodeScoreExportPayload(new Uint8Array([80, 75, 3, 4]), "{}"),
    });
    assert.equal(response.status, 200);
    const result = parseScoreExportResult(await response.json());
    assert.equal(result.saved, true);
    assert.equal(result.openStatus, "failed");
    assert.equal(result.openError, "viewer loader failed");
    assert.deepEqual(await fs.readFile(result.path), Buffer.from([80, 75, 3, 4]));
    assert.equal(await fs.readFile(result.diagnosticsPath, "utf8"), "{}");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (workbookPath) await fs.rm(path.dirname(workbookPath), { recursive: true });
  }
});
