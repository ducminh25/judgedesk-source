import { useEffect, useRef, useState, type Dispatch } from "react";
import { apiFetch } from "../../api";
import type {
  BatchJudgeRequest,
  JudgeProgress,
  JudgeStreamEvent,
  ProblemConfig
} from "../../types";
import type { JudgeResultsAction } from "./judge-results";
import {
  createLatestFrameScheduler,
  type LatestFrameScheduler,
} from "./progress-scheduler";

interface JudgeSessionOptions {
  contestantsPath: string;
  testPath: string;
  problemConfigs: Record<string, ProblemConfig>;
  dispatchResults: Dispatch<JudgeResultsAction>;
}

type ProgressFrame =
  | { kind: "animation"; id: number }
  | { kind: "timeout"; id: ReturnType<typeof globalThis.setTimeout> };

export function useJudgeSession({
  contestantsPath,
  testPath,
  problemConfigs,
  dispatchResults
}: JudgeSessionOptions) {
  const [isJudging, setIsJudging] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progressState, setProgressState] = useState<JudgeProgress | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef(false);
  const progressSchedulerRef = useRef<LatestFrameScheduler<JudgeProgress> | null>(null);
  if (!progressSchedulerRef.current) {
    const requestFrame = (callback: () => void): ProgressFrame => (
      typeof globalThis.requestAnimationFrame === "function"
        ? { kind: "animation", id: globalThis.requestAnimationFrame(callback) }
        : { kind: "timeout", id: globalThis.setTimeout(callback, 16) }
    );
    const cancelFrame = (frame: ProgressFrame) => {
      if (frame.kind === "animation") globalThis.cancelAnimationFrame(frame.id);
      else globalThis.clearTimeout(frame.id);
    };
    progressSchedulerRef.current = createLatestFrameScheduler(
      requestFrame,
      cancelFrame,
      setProgressState,
    );
  }

  useEffect(() => () => progressSchedulerRef.current?.cancel(), []);

  const runJudge = async (targetContestants: string[], targetProblems: string[]) => {
    if (activeRunRef.current) return;
    if (!contestantsPath.trim()) {
      setErrorMessage("MISSING_CONTESTANTS_PATH");
      return;
    }
    if (!testPath.trim()) {
      setErrorMessage("MISSING_TESTS_PATH");
      return;
    }
    if (targetContestants.length === 0 || targetProblems.length === 0) {
      setErrorMessage("NO_TARGETS_SELECTED");
      return;
    }

    setErrorMessage("");
    progressSchedulerRef.current?.cancel();
    activeRunRef.current = true;
    setIsJudging(true);
    setProgressState({
      contestant: "",
      problem: "",
      action: "initializing",
      percent: 0,
    });
    dispatchResults({ type: "initialize" });
    const newJobId = globalThis.crypto.randomUUID();
    setJobId(newJobId);

    try {
      abortControllerRef.current = new AbortController();
      const request: BatchJudgeRequest = {
        thisinhPath: contestantsPath,
        testPath,
        problemConfigs,
        targetContestants,
        targetProblems,
        jobId: newJobId
      };
      const response = await apiFetch("/api/batch-judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: abortControllerRef.current.signal
      });
      if (response.body) await consumeJudgeStream(response.body, handleEvent);
    } catch (error: any) {
      if (error.name !== "AbortError") {
        setErrorMessage(error.message || "Something went wrong during local execution.");
      }
    } finally {
      progressSchedulerRef.current?.cancel();
      activeRunRef.current = false;
      setIsJudging(false);
      setJobId(null);
      setProgressState(null);
      abortControllerRef.current = null;
    }
  };

  const terminate = async () => {
    if (!jobId) return;
    const currentJobId = jobId;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    try {
      await apiFetch("/api/batch-judge/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: currentJobId })
      });
    } finally {
      progressSchedulerRef.current?.cancel();
      activeRunRef.current = false;
      setIsJudging(false);
      setJobId(null);
      setProgressState(null);
    }
  };

  const handleEvent = (event: JudgeStreamEvent) => {
    if (event.type === "progress") {
      progressSchedulerRef.current?.schedule(event.data);
    } else if (event.type === "metadata") {
      setProgressState((prev) => prev ?? { contestant: "", problem: "", action: "Initializing...", percent: 0 });
      dispatchResults({ type: "set_metadata", metadata: event.data });
    } else if (event.type === "problem_completed") {
      dispatchResults({
        type: "merge_problem",
        contestant: event.data.contestant,
        problemResult: event.data.problemResult
      });
    } else if (event.type === "error") {
      setErrorMessage(event.data.message);
    }
  };

  return {
    errorMessage,
    isJudging,
    progressState,
    runJudge,
    setErrorMessage,
    terminate
  };
}

async function consumeJudgeStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: JudgeStreamEvent) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) parseEventLine(line, onEvent);
  }
  buffer += decoder.decode();
  parseEventLine(buffer, onEvent);
}

function parseEventLine(line: string, onEvent: (event: JudgeStreamEvent) => void): void {
  if (!line.trim()) return;
  try {
    onEvent(JSON.parse(line) as JudgeStreamEvent);
  } catch {
    // Ignore malformed partial lines; the backend emits one JSON object per line.
  }
}
