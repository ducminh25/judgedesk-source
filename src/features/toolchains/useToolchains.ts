import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "../../api.js";

export interface ToolchainProgress {
  id: string;
  status:
    "idle" | "downloading" | "extracting" | "verifying" | "success" | "failed";
  percent: number;
  bytesReceived: number;
  totalBytes: number;
  error?: string;
}

export interface ToolchainDescriptor {
  id: string;
  kind: "cpp" | "python";
  version: string;
  platform: string;
  arch: string;
  downloadUrl: string;
  sha256: string;
  archiveFormat: string;
  executableRelativePath: string;
  licenseFiles: string[];
  sizeBytes?: number;
  installed: boolean;
  progress: ToolchainProgress;
}

export interface ResolvedToolchain {
  kind: "cpp" | "python";
  source: "managed" | "custom" | "system" | "sandbox";
  executablePath: string;
  version: string;
  ready: boolean;
  diagnostic?: string;
}

export interface ToolchainState {
  platform: string;
  arch: string;
  manifestError?: string;
  preferences: {
    customCppPath?: string;
    customPythonPath?: string;
    preferredSourceCpp?: "managed" | "custom" | "system";
    preferredSourcePython?: "managed" | "custom" | "system";
    installedToolchains?: string[];
  };
  active: {
    cpp: ResolvedToolchain;
    python: ResolvedToolchain;
  };
  toolchains: ToolchainDescriptor[];
}

export function useToolchains() {
  const [state, setState] = useState<ToolchainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<number | null>(null);
  const initialRetryRef = useRef<number | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await apiFetch("/api/toolchains");
      const data = await res.json();
      setState(data);
      setError(null);
      return data as ToolchainState;
    } catch (err: any) {
      setError(err.message || "Failed to load toolchains state.");
      return null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = window.setInterval(async () => {
      const data = await fetchState();
      if (!data) return;

      const isAnyRunning = data.toolchains.some(
        (t) =>
          t.progress.status === "downloading" ||
          t.progress.status === "extracting" ||
          t.progress.status === "verifying",
      );
      if (!isAnyRunning && pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }, 1000);
  }, [fetchState]);

  useEffect(() => {
    let disposed = false;
    const loadInitialState = async (retriesRemaining: number) => {
      const data = await fetchState();
      if (disposed) return;
      if (data) {
        const isAnyRunning = data.toolchains.some(
          (t) =>
            t.progress.status === "downloading" ||
            t.progress.status === "extracting" ||
            t.progress.status === "verifying",
        );
        if (isAnyRunning) startPolling();
      } else if (retriesRemaining > 0) {
        initialRetryRef.current = window.setTimeout(
          () => void loadInitialState(retriesRemaining - 1),
          500,
        );
      }
    };

    void loadInitialState(10);

    return () => {
      disposed = true;
      if (initialRetryRef.current) {
        clearTimeout(initialRetryRef.current);
        initialRetryRef.current = null;
      }
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [fetchState, startPolling]);

  const install = async (id: string) => {
    try {
      setError(null);
      await apiFetch(`/api/toolchains/${id}/install`, { method: "POST" });
      startPolling();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  };

  const cancel = async (id: string) => {
    try {
      await apiFetch(`/api/toolchains/${id}/cancel`, { method: "POST" });
      await fetchState();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const uninstall = async (id: string) => {
    try {
      await apiFetch(`/api/toolchains/${id}`, { method: "DELETE" });
      await fetchState();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const saveCustomPath = async (kind: "cpp" | "python", customPath: string) => {
    try {
      await apiFetch("/api/toolchains/custom-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, path: customPath }),
      });
      await fetchState();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const savePreferredSource = async (
    kind: "cpp" | "python",
    source: "managed" | "custom" | "system",
  ) => {
    try {
      await apiFetch("/api/toolchains/custom-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, preferredSource: source }),
      });
      await fetchState();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return {
    state,
    error,
    refresh: fetchState,
    install,
    cancel,
    uninstall,
    saveCustomPath,
    savePreferredSource,
  };
}
