import type { Response } from "express";
import type { JudgeStreamEvent } from "../types.js";

export interface JudgeEventWriter {
  send<T extends JudgeStreamEvent["type"]>(type: T, data: Extract<JudgeStreamEvent, { type: T }>["data"]): void;
  end(): void;
}

export function createJudgeEventWriter(response: Response): JudgeEventWriter {
  response.setHeader("Content-Type", "application/x-ndjson");
  response.setHeader("Cache-Control", "no-cache");
  let terminal = false;
  let ended = false;
  return {
    send(type, data) {
      if (terminal || ended) return;
      if (type === "done" || type === "error") terminal = true;
      response.write(`${JSON.stringify({ type, data })}\n`);
    },
    end() {
      if (ended) return;
      ended = true;
      response.end();
    }
  };
}
