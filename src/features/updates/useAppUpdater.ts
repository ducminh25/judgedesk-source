import { useCallback, useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { apiFetch } from "../../api.js";
import {
  closeUpdateResources,
  parseUpdateCandidate,
  requireMatchingUpdateVersions,
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

  const checkForUpdates = useCallback(async () => {
    if (!isTauriRuntime()) return;
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
      if (host.distribution !== "core" && host.distribution !== "full") {
        throw new Error("Packaged JudgeDesk edition could not be identified");
      }
      const { check } = await import("@tauri-apps/plugin-updater");
      const settled = await Promise.allSettled(UPDATE_EDITIONS.map(async (edition) => {
        const target = updaterTargetForHost(host, edition);
        return {
          edition,
          target,
          update: await check({ timeout: 10_000, target }),
        };
      }));
      const successful = settled
        .filter((result): result is PromiseFulfilledResult<{
          edition: UpdateEdition;
          target: string;
          update: Update | null;
        }> => result.status === "fulfilled")
        .map((result) => result.value);
      for (const result of successful) checkedUpdates[result.edition] = result.update;
      const failure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
      if (generationRef.current !== generation) {
        await closeUpdateResources(Object.values(checkedUpdates));
        return;
      }
      if (successful.every(({ update }) => update === null)) {
        setState({ status: "current" });
        return;
      }
      if (successful.some(({ update }) => update === null)) {
        throw new Error("The latest release does not provide both Core and Full updates");
      }

      const candidateEntries = successful.map(({ edition, target, update }) => [
        edition,
        parseUpdateCandidate(update!, target, edition),
      ] as const);
      const candidates = Object.fromEntries(candidateEntries) as AppUpdateCandidates;
      const version = requireMatchingUpdateVersions(Object.values(candidates));
      updatesRef.current = checkedUpdates;
      checkedUpdates = emptyUpdates();
      candidatesRef.current = candidates;
      setState({
        status: "available",
        version,
        currentEdition: host.distribution,
        candidates,
      });
    } catch (error) {
      await closeUpdateResources(Object.values(checkedUpdates));
      if (generationRef.current !== generation) return;
      setState({
        status: "error",
        phase: "check",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const downloadUpdate = useCallback(async (edition: UpdateEdition) => {
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
    } catch (error) {
      if (generationRef.current !== generation) {
        await update.close();
        return;
      }
      setState({
        status: "error",
        phase: "download",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

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
