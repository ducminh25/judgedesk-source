import type { Response } from "express";
import type { JudgeStreamEvent } from "../types.js";

export interface JudgeEventWriter {
  send<T extends JudgeStreamEvent["type"]>(type: T, data: Extract<JudgeStreamEvent, { type: T }>["data"]): void;
  end(): void;
}

export function createJudgeEventWriter(response: Response): JudgeEventWriter {
  response.setHeader("Content-Type", "application/x-ndjson");
  response.setHeader("Cache-Control", "no-cache");
  return {
    send(type, data) {
      response.write(`${JSON.stringify({ type, data })}\n`);
    },
    end() {
      response.end();
    }
  };
}
