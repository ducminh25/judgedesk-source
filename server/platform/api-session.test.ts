import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import express from "express";
import {
  authorizeDesktopApiRequest,
  consumeApiSessionToken,
  createApiSessionTokenStore,
  createDesktopApiMiddleware,
  type DesktopApiBoundary,
} from "./api-session.js";

const boundary: DesktopApiBoundary = {
  port: 41_321,
  token: "a".repeat(64),
};

test("production consumes one canonical API session token", () => {
  const environment: NodeJS.ProcessEnv = { JUDGEDESK_API_TOKEN: "b".repeat(64) };
  assert.equal(consumeApiSessionToken(environment, true), "b".repeat(64));
  assert.equal(environment.JUDGEDESK_API_TOKEN, undefined);
  assert.throws(() => consumeApiSessionToken({}, true), /API session token/i);
  for (const invalid of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
    assert.throws(
      () => consumeApiSessionToken({ JUDGEDESK_API_TOKEN: invalid }, true),
      /API session token/i,
    );
  }
  assert.equal(consumeApiSessionToken({}, false), null);
});

test("API session token store consumes the environment only once", () => {
  const store = createApiSessionTokenStore();
  const environment: NodeJS.ProcessEnv = { JUDGEDESK_API_TOKEN: "d".repeat(64) };

  assert.equal(store.consume(environment, true), "d".repeat(64));
  assert.equal(environment.JUDGEDESK_API_TOKEN, undefined);
  environment.JUDGEDESK_API_TOKEN = "e".repeat(64);
  assert.equal(store.consume(environment, true), "d".repeat(64));
  assert.equal(environment.JUDGEDESK_API_TOKEN, "e".repeat(64));
});

test("desktop API middleware rejects unauthorized HTTP and authorizes preflight", async () => {
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

  const app = express();
  app.use("/api", createDesktopApiMiddleware({ port, token: boundary.token }));
  app.get("/api/status", (_request, response) => response.json({ ready: true }));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(port, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const url = `http://127.0.0.1:${port}/api/status`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, {
      headers: {
        Origin: "https://evil.test",
        "X-JudgeDesk-Session": boundary.token,
      },
    })).status, 403);
    const authorized = await fetch(url, {
      headers: {
        Origin: "tauri://localhost",
        "X-JudgeDesk-Session": boundary.token,
      },
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("access-control-allow-origin"), "tauri://localhost");
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-max-age"), "86400");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("desktop API authorization binds token, Host, and Origin", () => {
  const valid = {
    method: "POST",
    host: "127.0.0.1:41321",
    origin: "tauri://localhost",
    token: boundary.token,
  };
  assert.deepEqual(authorizeDesktopApiRequest(valid, boundary), { ok: true });
  assert.equal(authorizeDesktopApiRequest({ ...valid, token: undefined }, boundary).status, 401);
  assert.equal(authorizeDesktopApiRequest({ ...valid, token: "c".repeat(64) }, boundary).status, 401);
  assert.equal(authorizeDesktopApiRequest({ ...valid, host: "localhost:41321" }, boundary).status, 403);
  assert.equal(authorizeDesktopApiRequest({ ...valid, host: "evil.test" }, boundary).status, 403);
  assert.equal(authorizeDesktopApiRequest({ ...valid, origin: "https://evil.test" }, boundary).status, 403);
  assert.deepEqual(
    authorizeDesktopApiRequest({ ...valid, origin: undefined }, boundary),
    { ok: true },
  );
});

test("preflight omits the bearer token but never Host or Origin validation", () => {
  const preflight = {
    method: "OPTIONS",
    host: "127.0.0.1:41321",
    origin: "http://localhost:5173",
    token: undefined,
  };
  assert.deepEqual(authorizeDesktopApiRequest(preflight, boundary), { ok: true });
  assert.equal(
    authorizeDesktopApiRequest({ ...preflight, origin: "https://evil.test" }, boundary).status,
    403,
  );
});
