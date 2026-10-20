import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  authorizedApiHeaders,
  backendSessionFromIpc,
  backendBaseUrlForPort,
} from "./api.js";

test("desktop backend URL accepts only a concrete TCP port", () => {
  assert.equal(backendBaseUrlForPort(1), "http://127.0.0.1:1");
  assert.equal(backendBaseUrlForPort(65_535), "http://127.0.0.1:65535");
  for (const invalid of [undefined, null, 0, 65_536, 1.5, "3000", Number.NaN]) {
    assert.throws(() => backendBaseUrlForPort(invalid), /backend port/i);
  }
});

test("desktop backend session requires one canonical port and bearer token", () => {
  const token = "d".repeat(64);
  assert.deepEqual(backendSessionFromIpc({ port: 31_337, token }), { port: 31_337, token });
  for (const invalid of [
    null,
    { port: 31_337 },
    { port: 0, token },
    { port: 31_337, token: "D".repeat(64) },
    { port: 31_337, token: "d".repeat(63) },
    { port: 31_337, token, extra: true },
  ]) {
    assert.throws(() => backendSessionFromIpc(invalid), /backend session/i);
  }
});

test("API authorization overwrites caller-supplied session headers", () => {
  const headers = authorizedApiHeaders(
    { "Content-Type": "application/json", "X-JudgeDesk-Session": "forged" },
    "e".repeat(64),
  );
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-judgedesk-session"), "e".repeat(64));
});

test("desktop API initialization has no fixed-port fallback", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  assert.doesNotMatch(source, /127\.0\.0\.1:3000/);
  assert.doesNotMatch(source, /using fallback/i);
});

test("Tauri enables a bounded desktop CSP with IPC and loopback API access", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const csp = config.app.security.csp;
  assert.equal(typeof csp, "object");
  assert.match(csp["default-src"], /'self'/);
  assert.match(csp["connect-src"], /\bipc:/);
  assert.match(csp["connect-src"], /http:\/\/ipc\.localhost/);
  assert.match(csp["connect-src"], /http:\/\/127\.0\.0\.1:\*/);
  assert.doesNotMatch(csp["connect-src"], /ws:\/\/(?:localhost|127\.0\.0\.1):\*/);
  assert.equal(csp["object-src"], "'none'");
});

test("desktop frontend routes API traffic through the authenticated client", () => {
  const frontendRoot = path.join(process.cwd(), "src");
  const sourceFiles: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) {
        sourceFiles.push(entryPath);
      }
    }
  };
  visit(frontendRoot);

  const bypasses = sourceFiles.flatMap((sourcePath) => {
    const source = fs.readFileSync(sourcePath, "utf8");
    return /(?:fetch\s*\(\s*["']\/api\/|new\s+EventSource\s*\()/m.test(source)
      ? [path.relative(process.cwd(), sourcePath)]
      : [];
  });
  assert.deepEqual(bypasses, []);
});
