import { useCallback, useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  runUpdateInstallFlow,
  UpdateInstallFlowError,
} from "./install-flow.js";

export type AppUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number }
  | { status: "downloaded"; version: string }
  | {
      status: "error";
      phase: "check" | "download" | "prepare" | "install" | "relaunch";
      message: string;
    };

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function useAppUpdater() {
  const [state, setState] = useState<AppUpdateState>({ status: "idle" });
  const updateRef = useRef<Update | null>(null);
  const installInProgressRef = useRef(false);

  const checkForUpdates = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setState({ status: "checking" });
    try {
      if (updateRef.current) {
        await updateRef.current.close();
        updateRef.current = null;
      }
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 10_000 });
      if (!update) {
        setState({ status: "current" });
        return;
      }
      updateRef.current = update;
      setState({ status: "available", version: update.version });
    } catch (error) {
      setState({
        status: "error",
        phase: "check",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    let downloaded = 0;
    let contentLength = 0;
    setState({ status: "downloading", version: update.version, percent: 0 });
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength || 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
        }
        const percent = contentLength > 0
          ? Math.min(100, Math.round((downloaded / contentLength) * 100))
          : 0;
        setState({
          status: "downloading",
          version: update.version,
          percent: event.event === "Finished" ? 100 : percent,
        });
      });
      setState({ status: "downloaded", version: update.version });
    } catch (error) {
      setState({
        status: "error",
        phase: "download",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return false;
    if (installInProgressRef.current) return true;
    installInProgressRef.current = true;
    try {
      await runUpdateInstallFlow({
        prepare: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("prepare_for_update");
        },
        install: () => update.install(),
        relaunch: async () => {
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        },
      });
      return true;
    } catch (error) {
      setState({
        status: "error",
        phase: error instanceof UpdateInstallFlowError ? error.phase : "install",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      installInProgressRef.current = false;
    }
  }, []);

  useEffect(() => {
    void checkForUpdates();
    return () => {
      if (updateRef.current) void updateRef.current.close();
    };
  }, [checkForUpdates]);

  return { state, checkForUpdates, downloadUpdate, installUpdate };
}
