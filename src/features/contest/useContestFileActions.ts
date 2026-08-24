import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  buildContestManifest,
  chooseAndOpenContestArchive,
  openContestArchiveFromPath,
  saveContestArchive,
} from "./contest-file.js";
import {
  hasSavableContestData,
  shouldPromptForUnsavedContest,
} from "./dirty-state.js";
import {
  isDesktopReloadShortcut,
  shouldRegisterBrowserBeforeUnload,
} from "../desktop/browser-lifecycle.js";
import type { BatchJudgeResult, ProblemConfig } from "../../types.js";
import type { JudgeResultsAction } from "../judging/judge-results.js";
import type { formatAppError } from "../errors/app-error.js";
import type { useAppUpdater } from "../updates/useAppUpdater.js";

export type PendingContestAction =
  | "new"
  | "open"
  | "close"
  | { type: "open_path"; path: string };

export interface UseContestFileActionsOptions {
  contestantsList: string[];
  problemsList: string[];
  problemConfigs: Record<string, ProblemConfig>;
  selectedContestants: Record<string, boolean>;
  selectedProblems: Record<string, boolean>;
  judgeResult: BatchJudgeResult | null;
  thisinhPath: string;
  testPath: string;
  updater: ReturnType<typeof useAppUpdater>;
  isLocked: () => boolean;
  onResetWorkspace: () => void;
  onRestoreWorkspace: (data: {
    contestantsPath: string;
    testsPath: string;
    problemConfigs: Record<string, ProblemConfig>;
    selectedContestants: Record<string, boolean>;
    selectedProblems: Record<string, boolean>;
  }) => Promise<void>;
  dispatchJudgeResults: (action: JudgeResultsAction) => void;
  onClearErrors: () => void;
  setErrorMessage: (msg: string) => void;
  showError: (err: unknown, options?: Parameters<typeof formatAppError>[1]) => void;
  onResetFilters: () => void;
}

export function useContestFileActions({
  contestantsList,
  problemsList,
  problemConfigs,
  selectedContestants,
  selectedProblems,
  judgeResult,
  thisinhPath,
  testPath,
  updater,
  isLocked,
  onResetWorkspace,
  onRestoreWorkspace,
  dispatchJudgeResults,
  onClearErrors,
  setErrorMessage,
  showError,
  onResetFilters,
}: UseContestFileActionsOptions) {
  const { t } = useTranslation();
  const [contestFilePath, setContestFilePath] = useState<string | null>(null);
  const [contestCreatedAt, setContestCreatedAt] = useState<string | undefined>();
  const [isContestDirty, setIsContestDirty] = useState(false);
  const [isSavingContest, setIsSavingContest] = useState(false);
  const [pendingContestAction, setPendingContestAction] = useState<PendingContestAction | null>(null);
  const [isWindowDragging, setIsWindowDragging] = useState(false);

  const contestDirtyRef = useRef(false);
  const contestDataCountsRef = useRef({ contestants: 0, problems: 0 });
  const saveOperationRef = useRef(false);

  const setContestDirty = useCallback((dirty: boolean) => {
    contestDirtyRef.current = dirty;
    setIsContestDirty(dirty);
  }, []);

  const markContestDirty = useCallback(() => setContestDirty(true), [setContestDirty]);

  const hasContestData = hasSavableContestData(
    contestantsList.length,
    problemsList.length,
  );
  contestDataCountsRef.current = {
    contestants: contestantsList.length,
    problems: problemsList.length,
  };

  const saveStateRef = useRef({
    contestantsList,
    problemsList,
    problemConfigs,
    selectedContestants,
    selectedProblems,
    judgeResult,
    thisinhPath,
    testPath,
    contestFilePath,
    contestCreatedAt,
    t,
    showError,
  });
  saveStateRef.current = {
    contestantsList,
    problemsList,
    problemConfigs,
    selectedContestants,
    selectedProblems,
    judgeResult,
    thisinhPath,
    testPath,
    contestFilePath,
    contestCreatedAt,
    t,
    showError,
  };

  const handleSaveContest = async (forceSaveAs: boolean = false): Promise<boolean> => {
    if (isLocked() || saveOperationRef.current) return false;
    const state = saveStateRef.current;
    if (!state.thisinhPath.trim() && !state.testPath.trim()) return false;
    saveOperationRef.current = true;
    setIsSavingContest(true);
    try {
      const manifest = buildContestManifest({
        contestants: state.contestantsList,
        problems: state.problemsList,
        problemConfigs: state.problemConfigs,
        selectedContestants: state.selectedContestants,
        selectedProblems: state.selectedProblems,
        judgeResult: state.judgeResult,
      }, state.contestCreatedAt);
      const savedPath = await saveContestArchive({
        currentPath: forceSaveAs ? null : state.contestFilePath,
        contestantsPath: state.thisinhPath,
        testsPath: state.testPath,
        manifest,
      });
      if (!savedPath) return false;
      setContestFilePath(savedPath);
      setContestCreatedAt(manifest.createdAt);
      setContestDirty(false);
      onClearErrors();
      return true;
    } catch (error) {
      state.showError(error, {
        code: "CONTEST_SAVE_FAILED",
        title: state.t("appErrors.contestSaveFailed.title"),
      });
      return false;
    } finally {
      saveOperationRef.current = false;
      setIsSavingContest(false);
    }
  };

  const executeContestAction = useCallback(async (action: PendingContestAction): Promise<boolean> => {
    if (action === "close") {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await updater.discardUpdate();
        await getCurrentWindow().destroy();
        return true;
      } catch (error) {
        setContestDirty(true);
        showError(error);
        return false;
      }
    }

    if (action === "new") {
      onResetWorkspace();
      dispatchJudgeResults({ type: "replace", result: null });
      setContestFilePath(null);
      setContestCreatedAt(undefined);
      onResetFilters();
      onClearErrors();
      setContestDirty(false);
      return true;
    }

    try {
      const opened = typeof action === "object" && action.type === "open_path"
        ? await openContestArchiveFromPath(action.path)
        : await chooseAndOpenContestArchive();
      if (!opened) return false;
      const workspace = opened.manifest.workspace;
      await onRestoreWorkspace({
        contestantsPath: opened.contestantsPath,
        testsPath: opened.testsPath,
        problemConfigs: workspace.problemConfigs,
        selectedContestants: workspace.selectedContestants,
        selectedProblems: workspace.selectedProblems,
      });
      dispatchJudgeResults({ type: "replace", result: workspace.judgeResult });
      setContestFilePath(opened.path);
      setContestCreatedAt(opened.manifest.createdAt);
      onResetFilters();
      onClearErrors();
      setContestDirty(false);
      return true;
    } catch (error) {
      showError(error, {
        code: "CONTEST_OPEN_FAILED",
        title: t("appErrors.contestOpenFailed.title"),
      });
      return false;
    }
  }, [dispatchJudgeResults, onClearErrors, onResetFilters, onResetWorkspace, onRestoreWorkspace, setContestDirty, showError, t, updater]);

  const requestContestAction = useCallback((action: PendingContestAction) => {
    if (isLocked() || saveOperationRef.current) return;
    if (shouldPromptForUnsavedContest(
      contestDirtyRef.current,
      contestDataCountsRef.current.contestants,
      contestDataCountsRef.current.problems,
    )) {
      setPendingContestAction(action);
      return;
    }
    void executeContestAction(action);
  }, [executeContestAction, isLocked]);

  const continuePendingAction = async (saveFirst: boolean) => {
    const action = pendingContestAction;
    if (!action) return;
    if (saveFirst && !(await handleSaveContest())) return;
    setPendingContestAction(null);
    if (!saveFirst && action !== "open" && !(typeof action === "object" && action.type === "open_path")) {
      setContestDirty(false);
    }
    await executeContestAction(action);
  };

  const openContestFileByPath = useCallback((path: string) => {
    requestContestAction({ type: "open_path", path });
  }, [requestContestAction]);

  const initialContestCheckedRef = useRef(false);
  const executeContestActionRef = useRef(executeContestAction);
  executeContestActionRef.current = executeContestAction;
  const openContestFileByPathRef = useRef(openContestFileByPath);
  openContestFileByPathRef.current = openContestFileByPath;
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;
  const setErrorMessageRef = useRef(setErrorMessage);
  setErrorMessageRef.current = setErrorMessage;
  const updaterRef = useRef(updater);
  updaterRef.current = updater;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (initialContestCheckedRef.current) return;
    initialContestCheckedRef.current = true;
    async function checkInitialContest() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const initialFile = await invoke<string | null>("get_initial_contest_file");
        if (initialFile) {
          void executeContestActionRef.current({ type: "open_path", path: initialFile });
        }
      } catch (e) {
        // Not running in Tauri or no initial file
      }
    }
    void checkInitialContest();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function listenOpenContest() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("open_contest_file", (event) => {
          if (event.payload) {
            openContestFileByPathRef.current(event.payload);
          }
        });
      } catch (e) {
        // Not running in Tauri
      }
    }
    void listenOpenContest();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function setupDragDrop() {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "over") {
            setIsWindowDragging(true);
          } else if (event.payload.type === "drop") {
            setIsWindowDragging(false);
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
              const file = paths[0];
              if (file.toLowerCase().endsWith(".judgedesk")) {
                openContestFileByPathRef.current(file);
              }
            }
          } else {
            setIsWindowDragging(false);
          }
        });
      } catch (e) {
        // Not running in Tauri webview
      }
    }
    void setupDragDrop();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const useBrowserBeforeUnload = shouldRegisterBrowserBeforeUnload(window);
    const isTauri = !useBrowserBeforeUnload;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const counts = contestDataCountsRef.current;
      if (!shouldPromptForUnsavedContest(
        contestDirtyRef.current,
        counts.contestants,
        counts.problems,
      )) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const blockDesktopReload = (event: KeyboardEvent) => {
      if (!isTauri || !isDesktopReloadShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    if (useBrowserBeforeUnload) window.addEventListener("beforeunload", beforeUnload);
    else window.addEventListener("keydown", blockDesktopReload, true);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri) {
      void (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        const stopListening = await currentWindow.onCloseRequested((event) => {
          if (isLockedRef.current() || saveOperationRef.current) {
            event.preventDefault();
            setErrorMessageRef.current(tRef.current("actions.unavailableWhileBusy"));
            return;
          }
          const counts = contestDataCountsRef.current;
          if (shouldPromptForUnsavedContest(
            contestDirtyRef.current,
            counts.contestants,
            counts.problems,
          )) {
            event.preventDefault();
            setPendingContestAction("close");
            return;
          }
          event.preventDefault();
          void updaterRef.current.discardUpdate()
            .then(() => currentWindow.destroy())
            .catch((error) => {
              setErrorMessageRef.current(error instanceof Error ? error.message : String(error));
            });
        });
        if (disposed) stopListening();
        else unlisten = stopListening;
      })();
    }
    return () => {
      disposed = true;
      unlisten?.();
      if (useBrowserBeforeUnload) window.removeEventListener("beforeunload", beforeUnload);
      else window.removeEventListener("keydown", blockDesktopReload, true);
    };
  }, []);

  return {
    contestFilePath,
    contestCreatedAt,
    isContestDirty,
    isSavingContest,
    pendingContestAction,
    isWindowDragging,
    hasContestData,
    setPendingContestAction,
    setContestDirty,
    markContestDirty,
    handleSaveContest,
    executeContestAction,
    requestContestAction,
    continuePendingAction,
    openContestFileByPath,
  };
}
