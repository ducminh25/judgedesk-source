import { apiFetch } from "../../api.js";

export interface ParsedSseFrames {
  events: string[];
  remainder: string;
}

export function parseSseFrames(input: string): ParsedSseFrames {
  const events: string[] = [];
  const separator = /\r?\n\r?\n/g;
  let consumed = 0;
  for (let match = separator.exec(input); match; match = separator.exec(input)) {
    const frame = input.slice(consumed, match.index);
    consumed = separator.lastIndex;
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line === "data" ? "" : line.slice(5).replace(/^ /, ""));
    if (data.length > 0) events.push(data.join("\n"));
  }
  return { events, remainder: input.slice(consumed) };
}

export async function streamApiEvents(
  path: string,
  onData: (data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await apiFetch(path, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.body) throw new Error("JudgeDesk event stream has no response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const parsed = parseSseFrames(buffered);
      for (const data of parsed.events) {
        onData(data);
        if (signal.aborted) return;
      }
      buffered = parsed.remainder;
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

