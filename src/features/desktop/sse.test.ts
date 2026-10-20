import assert from "node:assert/strict";
import test from "node:test";
import { parseSseFrames } from "./sse.js";

test("SSE parser preserves chunk boundaries and joins data lines", () => {
  const first = parseSseFrames(": connected\r\ndata: {\"type\":\"one\"}\r\n");
  assert.deepEqual(first.events, []);
  const second = parseSseFrames(`${first.remainder}\r\ndata: line 1\ndata: line 2\n\n`);
  assert.deepEqual(second.events, ["{\"type\":\"one\"}", "line 1\nline 2"]);
  assert.equal(second.remainder, "");
});

test("SSE parser ignores comments and non-data fields", () => {
  assert.deepEqual(
    parseSseFrames(": keepalive\nevent: status\nid: 4\ndata: payload\n\n").events,
    ["payload"],
  );
});

test("streamApiEvents cancels reader and releases lock when aborted during stream", async () => {
  const { streamApiEvents } = await import("./sse.js");
  let cancelCalled = false;
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("data: {\"type\":\"osd_status\"}\n\n"));
      },
      cancel() {
        cancelCalled = true;
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    await streamApiEvents(
      "/api/osd/events",
      () => {
        controller.abort();
      },
      controller.signal,
    );
  } catch {
    // Expected abort or cancellation
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(cancelCalled, true, "ReadableStream reader must be cancelled when signal is aborted");
});

