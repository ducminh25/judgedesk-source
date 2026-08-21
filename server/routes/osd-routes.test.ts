import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { registerOsdRoutes } from "./osd-routes.js";
import { osdService } from "../judge/osd-service.js";

type RouteHandler = (req: any, res: any) => void;

function createMockApp() {
  const routes: Record<string, Record<string, RouteHandler>> = {
    get: {},
    post: {},
  };

  return {
    routes,
    get(path: string, handler: RouteHandler) {
      routes.get[path] = handler;
    },
    post(path: string, handler: RouteHandler) {
      routes.post[path] = handler;
    },
  };
}

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    write(_chunk: any) {},
    on(_event: string, _callback: any) {},
  };
  return res;
}

describe("osd-routes", () => {
  it("registers OSD endpoints and handles start/stop/status flow", () => {
    const mockApp = createMockApp();
    registerOsdRoutes(mockApp as any);

    assert.equal(typeof mockApp.routes.post["/api/osd/start"], "function");
    assert.equal(typeof mockApp.routes.post["/api/osd/stop"], "function");
    assert.equal(typeof mockApp.routes.get["/api/osd/status"], "function");
    assert.equal(typeof mockApp.routes.get["/api/osd/events"], "function");

    // 1. Check initial status
    const statusRes = createMockResponse();
    mockApp.routes.get["/api/osd/status"]({}, statusRes);
    assert.equal(statusRes.body.success, true);
    assert.equal(statusRes.body.status.active, false);

    // 2. Reject start when paths are missing
    const invalidStartRes = createMockResponse();
    mockApp.routes.post["/api/osd/start"]({ body: {} }, invalidStartRes);
    assert.equal(invalidStartRes.statusCode, 400);
    assert.equal(invalidStartRes.body.success, false);

    // 3. Start with valid directories
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_osd_routes_test_"));
    const osdDir = path.join(tempDir, "OSD");
    const contestantsDir = path.join(tempDir, "Contestants");
    const testDir = path.join(tempDir, "Tests");

    fs.mkdirSync(osdDir, { recursive: true });
    fs.mkdirSync(contestantsDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const validStartRes = createMockResponse();
      mockApp.routes.post["/api/osd/start"](
        {
          body: {
            osdPath: osdDir,
            contestantsPath: contestantsDir,
            testPath: testDir,
            enableLog: true,
          },
        },
        validStartRes,
      );

      assert.equal(validStartRes.body.success, true);
      assert.equal(validStartRes.body.status.active, true);
      assert.equal(osdService.isActive, true);

      // 4. Stop
      const stopRes = createMockResponse();
      mockApp.routes.post["/api/osd/stop"]({}, stopRes);
      assert.equal(stopRes.body.success, true);
      assert.equal(stopRes.body.status.active, false);
      assert.equal(osdService.isActive, false);
    } finally {
      osdService.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
