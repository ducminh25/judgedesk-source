import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { createJudgeEventWriter } from "./judge-event-writer.js";

interface ResponseFixture {
  response: Response;
  writes: string[];
  endCalls: number;
}

function createResponseFixture(): ResponseFixture {
  const writes: string[] = [];
  const fixture: ResponseFixture = {
    response: undefined as unknown as Response,
    writes,
    endCalls: 0,
  };
  fixture.response = {
    setHeader() {
      return fixture.response;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      fixture.endCalls += 1;
      return fixture.response;
    },
  } as unknown as Response;
  return fixture;
}

test("judge event writer emits exactly one terminal event and one stream end", () => {
  const fixture = createResponseFixture();
  const writer = createJudgeEventWriter(fixture.response);

  writer.send("progress", {
    contestant: "A",
    problem: "SUM",
    action: "progress.judging",
    percent: 50,
  });
  writer.send("done", { success: true });
  writer.send("error", { message: "late failure" });
  writer.send("progress", {
    contestant: "B",
    problem: "SUM",
    action: "progress.judging",
    percent: 75,
  });
  writer.send("done", { success: true });
  writer.end();
  writer.end();

  assert.equal(fixture.writes.length, 2);
  assert.deepEqual(
    fixture.writes.map((line) => JSON.parse(line) as unknown),
    [
      {
        type: "progress",
        data: {
          contestant: "A",
          problem: "SUM",
          action: "progress.judging",
          percent: 50,
        },
      },
      { type: "done", data: { success: true } },
    ],
  );
  assert.equal(fixture.endCalls, 1);
});

test("an error is terminal and suppresses every later event", () => {
  const fixture = createResponseFixture();
  const writer = createJudgeEventWriter(fixture.response);

  writer.send("error", { message: "judge infrastructure failed" });
  writer.send("done", { success: true });
  writer.end();

  assert.deepEqual(
    fixture.writes.map((line) => JSON.parse(line) as unknown),
    [{ type: "error", data: { message: "judge infrastructure failed" } }],
  );
  assert.equal(fixture.endCalls, 1);
});
