import { useEffect, useRef, useState, useCallback } from "react";
import { apiFetch } from "../../api";
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
  const eventSourceRef = useRef<EventSource | null>(null);

  const connectEvents = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Connect to SSE stream
    const es = new EventSource("/api/osd/events");
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      if (!event.data) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "osd_status") {
          setStatus(payload.data);
        } else if (payload.type === "osd_contestant_added") {
          if (payload.data?.contestant) {
            onContestantDiscovered(payload.data.contestant);
          }
        } else if (payload.type === "osd_problem_completed") {
          if (payload.data?.contestant && payload.data?.problemResult) {
            onProblemCompleted(payload.data.contestant, payload.data.problemResult);
          }
        } else if (payload.type === "osd_error") {
          setErrorMessage(payload.data?.message || "Lỗi OSD");
        }
      } catch {
        // ignore parse error
      }
    };

    es.onerror = () => {
      // Reconnection is handled automatically by EventSource
    };
  }, [onContestantDiscovered, onProblemCompleted]);

  useEffect(() => {
    connectEvents();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
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
