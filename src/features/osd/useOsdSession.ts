import { useEffect, useRef, useState, useCallback } from "react";
import { apiFetch } from "../../api";
import { streamApiEvents } from "../desktop/sse.js";
import type { ProblemConfig, ProblemResult } from "../../types";

export interface OsdStatusState {
  active: boolean;
  paused: boolean;
  osdPath: string | null;
  contestantsPath: string | null;
  testPath: string | null;
  enableLog: boolean;
  queueLength: number;
  currentJob: {
    id: string;
    contestant: string;
    problem: string;
    language: string;
    originalFileName: string;
  } | null;
  totalProcessed: number;
}

interface UseOsdSessionOptions {
  contestantsPath: string;
  testPath: string;
  problemConfigs: Record<string, ProblemConfig>;
  onContestantDiscovered: (contestant: string) => void;
  onProblemCompleted: (contestant: string, result: ProblemResult) => void;
}

function isSameOsdStatus(a: OsdStatusState, b: OsdStatusState): boolean {
  if (
    a.active !== b.active ||
    a.paused !== b.paused ||
    a.osdPath !== b.osdPath ||
    a.contestantsPath !== b.contestantsPath ||
    a.testPath !== b.testPath ||
    a.enableLog !== b.enableLog ||
    a.queueLength !== b.queueLength ||
    a.totalProcessed !== b.totalProcessed
  ) {
    return false;
  }
  if (a.currentJob === b.currentJob) return true;
  if (!a.currentJob || !b.currentJob) return false;
  return (
    a.currentJob.id === b.currentJob.id &&
    a.currentJob.contestant === b.currentJob.contestant &&
    a.currentJob.problem === b.currentJob.problem &&
    a.currentJob.language === b.currentJob.language &&
    a.currentJob.originalFileName === b.currentJob.originalFileName
  );
}

export function useOsdSession({
  contestantsPath,
  testPath,
  problemConfigs,
  onContestantDiscovered,
  onProblemCompleted,
}: UseOsdSessionOptions) {
  const [status, setStatus] = useState<OsdStatusState>({
    active: false,
    paused: false,
    osdPath: null,
    contestantsPath: null,
    testPath: null,
    enableLog: true,
    queueLength: 0,
    currentJob: null,
    totalProcessed: 0,
  });
  const [errorMessage, setErrorMessage] = useState<string>("");
  const eventAbortRef = useRef<AbortController | null>(null);
  const onContestantDiscoveredRef = useRef(onContestantDiscovered);
  const onProblemCompletedRef = useRef(onProblemCompleted);
  onContestantDiscoveredRef.current = onContestantDiscovered;
  onProblemCompletedRef.current = onProblemCompleted;

  const connectEvents = useCallback(() => {
    eventAbortRef.current?.abort();
    const controller = new AbortController();
    eventAbortRef.current = controller;
    const handleData = (data: string) => {
      if (!data) return;
      try {
        const payload = JSON.parse(data);
        if (payload.type === "osd_status" && payload.data) {
          setStatus((prev) => (isSameOsdStatus(prev, payload.data) ? prev : payload.data));
        } else if (payload.type === "osd_contestant_added") {
          if (payload.data?.contestant) {
            onContestantDiscoveredRef.current(payload.data.contestant);
          }
        } else if (payload.type === "osd_problem_completed") {
          if (payload.data?.contestant && payload.data?.problemResult) {
            onProblemCompletedRef.current(payload.data.contestant, payload.data.problemResult);
          }
        } else if (payload.type === "osd_error") {
          setErrorMessage(payload.data?.message || "Lỗi OSD");
        }
      } catch {
        // ignore parse error
      }
    };
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          await streamApiEvents("/api/osd/events", handleData, controller.signal);
        } catch {
          // A bounded reconnect preserves EventSource's former behavior.
        }
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        }
      }
    };
    void run();
  }, []);

  useEffect(() => {
    connectEvents();
    return () => {
      eventAbortRef.current?.abort();
      eventAbortRef.current = null;
    };
  }, [connectEvents]);

  const startOsd = async (options: { osdPath: string; enableLog?: boolean }) => {
    setErrorMessage("");
    try {
      const response = await apiFetch("/api/osd/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          osdPath: options.osdPath,
          contestantsPath,
          testPath,
          enableLog: options.enableLog !== false,
          problemConfigs,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Không thể khởi động OSD");
      }

      if (data.status) {
        setStatus(data.status);
      }
      return { success: true };
    } catch (err: any) {
      setErrorMessage(err.message || String(err));
      return { success: false, message: err.message };
    }
  };

  const stopOsd = async () => {
    try {
      const response = await apiFetch("/api/osd/stop", {
        method: "POST",
      });
      const data = await response.json();
      if (data.status) {
        setStatus(data.status);
      }
    } catch (err: any) {
      console.error("Stop OSD error:", err);
    }
  };

  return {
    status,
    errorMessage,
    setErrorMessage,
    startOsd,
    stopOsd,
  };
}
