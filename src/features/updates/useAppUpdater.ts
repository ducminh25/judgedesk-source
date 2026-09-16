import { useCallback, useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { apiFetch } from "../../api.js";
import {
  closeUpdateResources,
  parseUpdateCandidate,
  updaterTargetForHost,
  type AppUpdateCandidate,
  type UpdateEdition,
  type UpdateHostIdentity,
} from "./catalog.js";
import {
  runUpdateInstallFlow,
  UpdateInstallFlowError,
} from "./install-flow.js";

export type AppUpdateCandidates = Record<UpdateEdition, AppUpdateCandidate>;

export type CheckUpdateOutcome =
  | { status: "available"; version: string }
  | { status: "current" }
  | { status: "error"; message?: string }
  | { status: "noop" };

export interface CheckUpdateOptions {
  manual?: boolean;
}

export type AppUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | {
      status: "available";
      version: string;
      currentEdition: UpdateEdition;
      candidates: AppUpdateCandidates;
    }
  | {
      status: "downloading";
      version: string;
      edition: UpdateEdition;
      percent: number;
    }
  | { status: "downloaded"; version: string; edition: UpdateEdition }
  | {
      status: "error";
      phase: "check" | "download" | "prepare" | "install" | "relaunch";
      message: string;
    };

const UPDATE_EDITIONS = ["core", "full"] as const;

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function emptyUpdates(): Record<UpdateEdition, Update | null> {
  return { core: null, full: null };
}

export function useAppUpdater() {
  const [state, setState] = useState<AppUpdateState>({ status: "idle" });
  const updatesRef = useRef<Record<UpdateEdition, Update | null>>(emptyUpdates());
  const candidatesRef = useRef<AppUpdateCandidates | null>(null);
  const generationRef = useRef(0);
  const installInProgressRef = useRef(false);

  const discardUpdate = useCallback(async () => {
    generationRef.current += 1;
    const updates = updatesRef.current;
    updatesRef.current = emptyUpdates();
    candidatesRef.current = null;
    await closeUpdateResources(Object.values(updates));
  }, []);

  const downloadUpdate = useCallback(async (edition: UpdateEdition = "core") => {
    const update = updatesRef.current[edition];
    const candidate = candidatesRef.current?.[edition];
    if (!update || !candidate) return;
    const generation = generationRef.current;
    const otherEdition: UpdateEdition = edition === "core" ? "full" : "core";
    const otherUpdate = updatesRef.current[otherEdition];
    updatesRef.current[otherEdition] = null;
    await closeUpdateResources([otherUpdate]);

    let downloaded = 0;
    let contentLength = 0;
    setState({
      status: "downloading",
      version: candidate.version,
      edition,
      percent: 0,
    });
    try {
      await update.download((event) => {
        if (generationRef.current !== generation) return;
        if (event.event === "Started") {
          contentLength = event.data.contentLength || candidate.downloadSizeBytes;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
        }
        const percent = contentLength > 0
          ? Math.min(100, Math.round((downloaded / contentLength) * 100))
          : 0;
        setState({
          status: "downloading",
          version: candidate.version,
          edition,
          percent: event.event === "Finished" ? 100 : percent,
        });
      });
      if (generationRef.current !== generation) {
        await update.close();
        return;
      }
      setState({ status: "downloaded", version: candidate.version, edition });
    } catch (_error) {
      if (generationRef.current !== generation) {
        await update.close();
        return;
      }
      setState({ status: "idle" });
    }
  }, []);

  const checkForUpdates = useCallback(async (options: CheckUpdateOptions = {}): Promise<CheckUpdateOutcome> => {
    if (!isTauriRuntime()) {
      if (options.manual) {
        return { status: "current" };
      }
      return { status: "noop" };
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const previous = updatesRef.current;
    updatesRef.current = emptyUpdates();
    candidatesRef.current = null;
    setState({ status: "checking" });
    await closeUpdateResources(Object.values(previous));

    let checkedUpdates: Record<UpdateEdition, Update | null> = emptyUpdates();
    try {
      const response = await apiFetch("/api/distribution");
      const host = await response.json() as UpdateHostIdentity;
      const { check } = await import("@tauri-apps/plugin-updater");
      const target = updaterTargetForHost(host, "core");
      const update = await check({ timeout: 10_000, target });
      checkedUpdates.core = update;

      if (generationRef.current !== generation) {
        await closeUpdateResources(Object.values(checkedUpdates));
        return { status: "noop" };
      }
      if (!update) {
        setState({ status: "current" });
        return { status: "current" };
      }

      const candidate = parseUpdateCandidate(update, target, "core");
      const candidates: AppUpdateCandidates = { core: candidate, full: candidate };
      updatesRef.current = checkedUpdates;
      checkedUpdates = emptyUpdates();
      candidatesRef.current = candidates;

      void downloadUpdate("core");
      return { status: "available", version: candidate.version };
    } catch (error) {
      await closeUpdateResources(Object.values(checkedUpdates));
      if (generationRef.current !== generation) return { status: "noop" };
      setState({ status: "idle" });
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, [downloadUpdate]);

  const installUpdate = useCallback(async () => {
    const update = updatesRef.current.core ?? updatesRef.current.full;
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
      void discardUpdate();
    };
  }, [checkForUpdates, discardUpdate]);

  return {
    state,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    discardUpdate,
  };
}
