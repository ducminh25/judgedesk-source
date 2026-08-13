import React, { useCallback, useEffect, useState, useMemo, useRef, useReducer } from "react";
import { HostStatus, ProblemResult } from "./types";
import ProblemConfigModal from "./components/ProblemConfigModal";
import ProgressWindow from "./components/ProgressWindow";
import JudgingDetailsModal from "./components/JudgingDetailsModal";
import ScoringLogModal from "./components/ScoringLogModal";
import { apiFetch } from "./api";
import { buildScoreExport } from "./features/export/score-workbook-client";
import {
  encodeScoreExportPayload,
  SCORE_EXPORT_CONTENT_TYPE,
} from "../shared/score-export-wire";
import {
  judgeResultsReducer,
  problemHasPositiveScore,
  type JudgeResultsAction,
} from "./features/judging/judge-results";
import {
  canExportScoreboard,
  canStartJudge,
  selectedNames,
} from "./features/judging/availability";
import { useJudgeSession } from "./features/judging/useJudgeSession";
import {
  isDesktopReloadShortcut,
  shouldRegisterBrowserBeforeUnload,
} from "./features/desktop/browser-lifecycle";
import { useContestWorkspace } from "./features/workspace/useContestWorkspace";
import { createDefaultProblemConfig } from "../shared/problem-config";
import Scoreboard, {
  type ScoreboardActionTarget,
} from "./features/scoreboard/Scoreboard";
import DirectoryPickerModal from "./components/DirectoryPickerModal";
import EntityActionMenu from "./components/EntityActionMenu";
import AppToolbar from "./components/AppToolbar";
import HelpCenter, {
  isHelpShortcut,
  type HelpSectionId,
} from "./features/help/HelpCenter.js";
import { useTranslation } from "react-i18next";
import ToolchainManager from "./features/toolchains/ToolchainManager.js";
import type { ToolchainState } from "./features/toolchains/useToolchains.js";
import { useAppUpdater } from "./features/updates/useAppUpdater.js";
import {
  requiresEditionChange,
  type UpdateEdition,
} from "./features/updates/catalog.js";
import {
  DonationConfirmDialog,
  UpdateEditionChangeDialog,
  UpdateEditionDialog,
} from "./features/updates/UpdateDialogs.js";
import UnsavedContestDialog from "./components/UnsavedContestDialog";
import ScoreDeleteConfirmDialog from "./components/ScoreDeleteConfirmDialog";
import ContestSaveProgressDialog from "./components/ContestSaveProgressDialog";
import {
  buildContestManifest,
  chooseAndOpenContestArchive,
  saveContestArchive,
} from "./features/contest/contest-file";
import {
  hasSavableContestData,
  shouldPromptForUnsavedContest,
} from "./features/contest/dirty-state";

type PendingContestAction = "new" | "open" | "close";
const DONATION_QR_URL = "https://img.vietqr.io/image/MB-0835385259-compact.png?amount=&addInfo=JudgeDesk%20Donation";
type PendingScoreDeletion =
  | { type: "selected"; contestantNames: string[]; problemNames: string[] }
  | { type: "result"; contestantName: string; problemName: string }
  | { type: "problem"; problemName: string }
  | { type: "contestant"; contestantName: string };

export default function App() {
  const { t } = useTranslation();
  const {
    contestants: contestantsList,
    contestantsPath: thisinhPath,
    contestantsPickerPath,
    customCheckers: customCheckersMap,
    loadContestants: handleFetchContestants,
    loadProblems: handleFetchProblems,
    problemConfigs,
    problems: problemsList,
    resetWorkspace,
    restoreWorkspace,
    saveProblemConfig,
    selectedContestants,
    selectedProblems,
    setContestantsPath: setThisinhPath,
    setSelectedContestants,
    setSelectedProblems,
    setTestPath,
    testPath,
    testsPickerPath,
  } = useContestWorkspace();
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [contestantSort, setContestantSort] = useState<
    "default" | "asc" | "desc" | "score"
  >("default");
  const [problemSort, setProblemSort] = useState<"default" | "asc" | "desc">(
    "default",
  );

  // Modals
  const [activeConfigProblem, setActiveConfigProblem] = useState<string | null>(
    null,
  );
  const [activeDetails, setActiveDetails] = useState<{
    cont: string;
    data: ProblemResult;
  } | null>(null);
  const [activeLog, setActiveLog] = useState<{
    type: "problem" | "contestant";
    name: string;
  } | null>(null);
  const [actionMenu, setActionMenu] = useState<ScoreboardActionTarget | null>(
    null,
  );
  const [loadModal, setLoadModal] = useState<"tests" | "contestants" | null>(
    null,
  );
  const [modalPath, setModalPath] = useState<string>("");
  const [openToolchains, setOpenToolchains] = useState(false);
  const [helpSection, setHelpSection] = useState<HelpSectionId | null>(null);
  const [showInstallUpdate, setShowInstallUpdate] = useState(false);
  const [showUpdateChoices, setShowUpdateChoices] = useState(false);
  const [pendingUpdateEdition, setPendingUpdateEdition] = useState<UpdateEdition | null>(null);
  const [showDonationConfirm, setShowDonationConfirm] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateRestartError, setUpdateRestartError] = useState("");
  const [contestFilePath, setContestFilePath] = useState<string | null>(null);
  const [contestCreatedAt, setContestCreatedAt] = useState<string | undefined>();
  const [isContestDirty, setIsContestDirty] = useState(false);
  const [isSavingContest, setIsSavingContest] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [pendingContestAction, setPendingContestAction] = useState<PendingContestAction | null>(null);
  const [pendingScoreDeletion, setPendingScoreDeletion] = useState<PendingScoreDeletion | null>(null);
  const contestDirtyRef = useRef(false);
  const contestDataCountsRef = useRef({ contestants: 0, problems: 0 });
  const interactionLockedRef = useRef(false);
  const hostStatusRequestRef = useRef<Promise<void> | null>(null);
  const saveOperationRef = useRef(false);
  const exportOperationRef = useRef(false);
  const updater = useAppUpdater();
  const updateRequiresRestart =
    updater.state.status === "error" &&
    (updater.state.phase === "prepare" ||
      updater.state.phase === "install" ||
      updater.state.phase === "relaunch");
  const updateHandoffActive = isInstallingUpdate || updateRequiresRestart;

  const setContestDirty = useCallback((dirty: boolean) => {
    contestDirtyRef.current = dirty;
    setIsContestDirty(dirty);
  }, []);

  const markContestDirty = useCallback(() => setContestDirty(true), [setContestDirty]);
  const updateSelectedContestants = useCallback((
    update: React.SetStateAction<Record<string, boolean>>,
  ) => {
    setSelectedContestants(update);
    markContestDirty();
  }, [markContestDirty, setSelectedContestants]);
  const updateSelectedProblems = useCallback((
    update: React.SetStateAction<Record<string, boolean>>,
  ) => {
    setSelectedProblems(update);
    markContestDirty();
  }, [markContestDirty, setSelectedProblems]);
  const openResultDetails = useCallback((cont: string, data: ProblemResult) => {
    setActiveDetails({ cont, data });
  }, []);

  const hasContestData = hasSavableContestData(
    contestantsList.length,
    problemsList.length,
  );
  contestDataCountsRef.current = {
    contestants: contestantsList.length,
    problems: problemsList.length,
  };

  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [backendErrorMessage, setBackendErrorMessage] = useState("");
  const [judgeResult, dispatchJudgeResults] = useReducer(
    judgeResultsReducer,
    null,
  );
  const dispatchResults = useCallback((action: JudgeResultsAction) => {
    dispatchJudgeResults(action);
    if (action.type !== "replace") markContestDirty();
  }, [markContestDirty]);

  const displayedProblems = useMemo(() => {
    let list = problemsList;
    if (problemSort === "asc") {
      return [...list].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      );
    } else if (problemSort === "desc") {
      return [...list].sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
      );
    }
    return list;
  }, [problemsList, problemSort]);

  const orderedContestants = useMemo(() => {
    const list = contestantsList;
    if (contestantSort === "score") {
      const activeProblems = problemsList.filter((p) => selectedProblems[p]);
      const scoresMap: Record<string, number> = {};

      list.forEach((cont) => {
        const ctData = judgeResult?.contestants.find(
          (c) => c.contestantName === cont,
        );
        const totalScore =
          ctData && ctData.problems
            ? ctData.problems
                .filter(
                  (p) =>
                    p &&
                    p.problemName &&
                    activeProblems.some(
                      (ap) => ap.toLowerCase() === p.problemName.toLowerCase(),
                    ),
                )
                .reduce((acc, p) => acc + (p.summary?.score ?? 0), 0)
            : 0;
        scoresMap[cont] = totalScore;
      });

      return [...list].sort(
        (a, b) => (scoresMap[b] ?? 0) - (scoresMap[a] ?? 0),
      );
    } else if (contestantSort === "asc") {
      return [...list].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      );
    } else if (contestantSort === "desc") {
      return [...list].sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
      );
    }

    return list;
  }, [
    contestantsList,
    contestantSort,
    judgeResult,
    selectedProblems,
    problemsList,
  ]);

  const displayedContestants = useMemo(() => {
    if (!searchTerm.trim()) return orderedContestants;
    const lower = searchTerm.toLowerCase();
    return orderedContestants.filter((contestant) => contestant.toLowerCase().includes(lower));
  }, [orderedContestants, searchTerm]);

  const activeLoadModalRef = useRef<"tests" | "contestants" | null>(null);

  const requestHostStatus = useCallback(() => {
    if (hostStatusRequestRef.current) return;
    setHostStatus(null);
    const request = (async () => {
      try {
        const response = await apiFetch("/api/status");
        setHostStatus(await response.json());
        setBackendErrorMessage("");
      } catch (error) {
        console.error("Failed to load host status", error);
        setBackendErrorMessage(t("errors.backendConnection"));
      } finally {
        hostStatusRequestRef.current = null;
      }
    })();
    hostStatusRequestRef.current = request;
  }, [t]);

  const loadHelpToolchains = useCallback(async (): Promise<ToolchainState> => {
    const response = await apiFetch("/api/toolchains");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as ToolchainState;
  }, []);

  useEffect(() => {
    requestHostStatus();
  }, [requestHostStatus]);

  useEffect(() => {
    const openHelpOnF1 = (event: KeyboardEvent) => {
      if (!isHelpShortcut(event) || updateHandoffActive) return;
      event.preventDefault();
      event.stopPropagation();
      setHelpSection((current) => current ?? "quick-start");
    };
    window.addEventListener("keydown", openHelpOnF1, true);
    return () => window.removeEventListener("keydown", openHelpOnF1, true);
  }, [updateHandoffActive]);

  useEffect(() => {
    activeLoadModalRef.current = loadModal;
    if (loadModal) {
      setModalPath(loadModal === "tests" ? testsPickerPath : contestantsPickerPath);
    }
  }, [contestantsPickerPath, loadModal, testsPickerPath]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function setupTauri() {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const appWebview = getCurrentWebview();
        unlisten = await appWebview.onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            if (interactionLockedRef.current) return;
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
              const absolutePath = paths[0];
              console.log("Tauri file drop event path:", absolutePath);

              const currentModal = activeLoadModalRef.current;
              if (currentModal === "tests") {
                setTestPath(absolutePath);
                void handleFetchProblems(absolutePath);
                markContestDirty();
                setLoadModal(null);
              } else if (currentModal === "contestants") {
                setThisinhPath(absolutePath);
                void handleFetchContestants(absolutePath);
                markContestDirty();
                setLoadModal(null);
              }
            }
          }
        });
      } catch (e) {
        console.log("Tauri drag-drop not supported in this environment");
      }
    }
    setupTauri();
    return () => {
      if (unlisten) unlisten();
    };
  }, [handleFetchContestants, handleFetchProblems, markContestDirty, setTestPath, setThisinhPath]);

  const {
    errorMessage,
    isJudging,
    progressState,
    runJudge: runJudgeTargets,
    setErrorMessage,
    terminate: handleTerminate,
  } = useJudgeSession({
    contestantsPath: thisinhPath,
    testPath,
    problemConfigs,
    dispatchResults,
  });
  const interactionLocked =
    isJudging || isSavingContest || updateHandoffActive;
  interactionLockedRef.current = interactionLocked;

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
    // Chromium's browser-level beforeunload prompt fights Tauri's native close
    // handler and can also interrupt Vite hot reloads. Only regular browser usage
    // needs it; the desktop app is protected by onCloseRequested below.
    if (useBrowserBeforeUnload) window.addEventListener("beforeunload", beforeUnload);
    else window.addEventListener("keydown", blockDesktopReload, true);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri) {
      void (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        const stopListening = await currentWindow.onCloseRequested((event) => {
          if (interactionLockedRef.current || saveOperationRef.current) {
            event.preventDefault();
            setErrorMessage(t("actions.unavailableWhileBusy"));
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
          void updater.discardUpdate()
            .then(() => currentWindow.destroy())
            .catch((error) => {
              setErrorMessage(error instanceof Error ? error.message : String(error));
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
  }, [t, updater.discardUpdate]);

  const handleSaveContest = async (): Promise<boolean> => {
    if (interactionLockedRef.current || saveOperationRef.current) return false;
    if (!thisinhPath.trim() && !testPath.trim()) return false;
    saveOperationRef.current = true;
    setIsSavingContest(true);
    try {
      const manifest = buildContestManifest({
        contestants: contestantsList,
        problems: problemsList,
        problemConfigs,
        selectedContestants,
        selectedProblems,
        judgeResult,
      }, contestCreatedAt);
      const savedPath = await saveContestArchive({
        currentPath: contestFilePath,
        contestantsPath: thisinhPath,
        testsPath: testPath,
        manifest,
      });
      if (!savedPath) return false;
      setContestFilePath(savedPath);
      setContestCreatedAt(manifest.createdAt);
      setContestDirty(false);
      setErrorMessage("");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(`${t("contest.saveFailed")}: ${message}`);
      return false;
    } finally {
      saveOperationRef.current = false;
      setIsSavingContest(false);
    }
  };

  const executeContestAction = async (action: PendingContestAction): Promise<boolean> => {
    if (action === "close") {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        // The close request was already confirmed. Destroying avoids emitting
        // another closeRequested event and works consistently on Windows and
        // macOS (where the title-bar close control follows the same path).
        await updater.discardUpdate();
        await getCurrentWindow().destroy();
        return true;
      } catch (error) {
        setContestDirty(true);
        setErrorMessage(error instanceof Error ? error.message : String(error));
        return false;
      }
    }

    if (action === "new") {
      resetWorkspace();
      dispatchJudgeResults({ type: "replace", result: null });
      setContestFilePath(null);
      setContestCreatedAt(undefined);
      setSearchTerm("");
      setContestantSort("default");
      setProblemSort("default");
      setErrorMessage("");
      setContestDirty(false);
      return true;
    }

    try {
      const opened = await chooseAndOpenContestArchive();
      if (!opened) return false;
      const workspace = opened.manifest.workspace;
      await restoreWorkspace({
        contestantsPath: opened.contestantsPath,
        testsPath: opened.testsPath,
        problemConfigs: workspace.problemConfigs,
        selectedContestants: workspace.selectedContestants,
        selectedProblems: workspace.selectedProblems,
      });
      dispatchJudgeResults({ type: "replace", result: workspace.judgeResult });
      setContestFilePath(opened.path);
      setContestCreatedAt(opened.manifest.createdAt);
      setSearchTerm("");
      setContestantSort("default");
      setProblemSort("default");
      setErrorMessage("");
      setContestDirty(false);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(`${t("contest.openFailed")}: ${message}`);
      return false;
    }
  };

  const requestContestAction = (action: PendingContestAction) => {
    if (interactionLockedRef.current || saveOperationRef.current) return;
    if (shouldPromptForUnsavedContest(
      contestDirtyRef.current,
      contestantsList.length,
      problemsList.length,
    )) {
      setPendingContestAction(action);
      return;
    }
    void executeContestAction(action);
  };

  const continuePendingAction = async (saveFirst: boolean) => {
    const action = pendingContestAction;
    if (!action) return;
    if (saveFirst && !(await handleSaveContest())) return;
    setPendingContestAction(null);
    if (!saveFirst && action !== "open") setContestDirty(false);
    await executeContestAction(action);
  };

  const runJudge = (
    contestantsOverride?: string[],
    problemsOverride?: string[],
  ) => {
    if (interactionLockedRef.current || saveOperationRef.current) return Promise.resolve();
    const contestants =
      contestantsOverride ??
      selectedNames(orderedContestants, selectedContestants);
    const problems =
      problemsOverride ??
      selectedNames(displayedProblems, selectedProblems);
    return runJudgeTargets(contestants, problems);
  };

  const selectedContestantNames = selectedNames(contestantsList, selectedContestants);
  const selectedProblemNames = selectedNames(problemsList, selectedProblems);
  const canRun = canStartJudge({
    contestantsPath: thisinhPath,
    testsPath: testPath,
    contestantNames: selectedContestantNames,
    problemNames: selectedProblemNames,
    secureRunnerReady: hostStatus?.secureRunner.ready === true,
  });
  const canDeleteSelected = !!judgeResult?.contestants.some(
    (contestant) => selectedContestants[contestant.contestantName]
      && contestant.problems.some((problem) => selectedProblemNames.some(
        (selected) => selected.toLowerCase() === problem.problemName.toLowerCase(),
      )),
  );

  const pendingScoreDeletionDescription = useMemo(() => {
    if (!pendingScoreDeletion) return "";
    if (pendingScoreDeletion.type === "selected") {
      return t("actions.confirmDeleteSelectedMessage", {
        contestants: pendingScoreDeletion.contestantNames.length,
        problems: pendingScoreDeletion.problemNames.length,
      });
    }
    if (pendingScoreDeletion.type === "result") {
      return t("actions.confirmDeleteResultMessage", {
        contestant: pendingScoreDeletion.contestantName,
        problem: pendingScoreDeletion.problemName,
      });
    }
    if (pendingScoreDeletion.type === "problem") {
      return t("actions.confirmDeleteProblemMessage", { problem: pendingScoreDeletion.problemName });
    }
    return t("actions.confirmDeleteContestantMessage", { contestant: pendingScoreDeletion.contestantName });
  }, [pendingScoreDeletion, t]);

  const confirmScoreDeletion = () => {
    const request = pendingScoreDeletion;
    if (!request || interactionLockedRef.current || saveOperationRef.current) return;
    if (request.type === "selected") {
      dispatchResults({
        type: "delete_selected",
        contestantNames: request.contestantNames,
        problemNames: request.problemNames,
      });
    } else if (request.type === "result") {
      dispatchResults({
        type: "delete_result",
        contestantName: request.contestantName,
        problemName: request.problemName,
      });
    } else if (request.type === "problem") {
      dispatchResults({ type: "delete_problem", problemName: request.problemName });
    } else {
      dispatchResults({ type: "delete_contestant", contestantName: request.contestantName });
    }
    setPendingScoreDeletion(null);
  };

  const findProblemResult = (contestantName: string, problemName: string) =>
    judgeResult?.contestants
      .find((contestant) => contestant.contestantName === contestantName)
      ?.problems.find(
        (problem) => problem.problemName.toLowerCase() === problemName.toLowerCase(),
      );

  const handleExportExcel = async () => {
    if (
      interactionLockedRef.current
      || saveOperationRef.current
      || exportOperationRef.current
    ) return;
    exportOperationRef.current = true;
    setIsExporting(true);
    setErrorMessage("");
    try {
      const activeProblems = displayedProblems.filter(
        (problem) => selectedProblems[problem],
      );
      const activeContestants = displayedContestants.filter(
        (contestant) => selectedContestants[contestant],
      );
      const scoreExport = await buildScoreExport(
        judgeResult ?? { success: true, contestants: [] },
        activeContestants,
        activeProblems,
        t,
      );
      const payload = encodeScoreExportPayload(
        scoreExport.workbook,
        scoreExport.diagnosticJson,
      );
      const response = await apiFetch("/api/open-excel", {
        method: "POST",
        headers: { "Content-Type": SCORE_EXPORT_CONTENT_TYPE },
        body: payload,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(failure?.message || `HTTP ${response.status}`);
      }
    } catch (error: any) {
      setErrorMessage(error.message || "Failed to open the Excel workbook.");
    } finally {
      exportOperationRef.current = false;
      setIsExporting(false);
    }
  };

  return (
    <div
      id="local-online-judge"
      className="h-screen bg-surface text-text-primary font-sans flex flex-col overflow-hidden"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        inert={updateHandoffActive ? true : undefined}
        aria-hidden={updateHandoffActive ? true : undefined}
      >
      <AppToolbar
        canDeleteSelected={canDeleteSelected}
        canExport={canExportScoreboard(contestantsList, problemsList)}
        canRun={canRun}
        canSaveContest={isContestDirty && hasContestData}
        errorMessage={backendErrorMessage || errorMessage}
        hostStatus={hostStatus}
        interactionLocked={interactionLocked}
        isJudging={isJudging}
        isExporting={isExporting}
        isSavingContest={isSavingContest}
        onDeleteSelected={() => {
          setPendingScoreDeletion({
            type: "selected",
            contestantNames: selectedContestantNames,
            problemNames: selectedProblemNames,
          });
        }}
        onExport={() => {
          void handleExportExcel();
        }}
        onNewContest={() => requestContestAction("new")}
        onOpenContest={() => requestContestAction("open")}
        onOpenContestants={() => {
          setLoadModal("contestants");
          setModalPath(contestantsPickerPath);
        }}
        onOpenTests={() => {
          setLoadModal("tests");
          setModalPath(testsPickerPath);
        }}
        onReload={() => {
          void Promise.all([
            handleFetchContestants(undefined, { preserveSelection: true }),
            handleFetchProblems(undefined, { preserveSelection: true }),
          ]).then(() => {
            markContestDirty();
          });
        }}
        onRun={() => {
          void runJudge();
        }}
        onSaveContest={() => {
          void handleSaveContest();
        }}
        onOpenHelp={() => setHelpSection("quick-start")}
        onOpenDonation={() => setShowDonationConfirm(true)}
        onOpenToolchains={() => setOpenToolchains(true)}
        onRequestHostStatus={requestHostStatus}
        updateState={updater.state}
        onCheckUpdates={() => void updater.checkForUpdates()}
        onOpenUpdateChoices={() => {
          if (updater.state.status === "available") setShowUpdateChoices(true);
        }}
        onRequestInstall={() => setShowInstallUpdate(true)}
      />

      <Scoreboard
        allContestants={contestantsList}
        contestants={displayedContestants}
        contestantSort={contestantSort}
        problems={displayedProblems}
        result={judgeResult}
        selectedContestants={selectedContestants}
        selectedProblems={selectedProblems}
        interactionLocked={interactionLocked}
        setContestantSort={setContestantSort}
        setSelectedContestants={updateSelectedContestants}
        setSelectedProblems={updateSelectedProblems}
        onOpenActions={setActionMenu}
        onOpenDetails={openResultDetails}
      />

      <footer className="flex h-7 flex-none items-center justify-between border-t border-surface-border bg-surface-elevated px-3 text-[10px] text-text-muted">
        <div className="flex items-center gap-3">
          <span>{isJudging ? t("status.judging") : t("status.ready")}</span>
          <span>{contestantsList.length} {t("scoreboard.contestants").toLowerCase()}</span>
          <span>{problemsList.length} {t("scoringLog.problem").toLowerCase()}</span>
          <span className="max-w-64 truncate font-mono" title={contestFilePath || undefined}>
            {contestFilePath ? contestFilePath.split(/[\\/]/).pop() : t("contest.untitled")}{isContestDirty && hasContestData ? " *" : ""}
          </span>
        </div>
        {hostStatus?.sandbox?.mode && <div className="font-mono">{hostStatus.sandbox.mode}</div>}
      </footer>

      {loadModal && (
        <DirectoryPickerModal
          kind={loadModal}
          path={modalPath}
          onPathChange={setModalPath}
          onClose={() => setLoadModal(null)}
          onDropPath={(path) => {
            if (loadModal === "tests") {
              setTestPath(path);
              void handleFetchProblems(path);
              markContestDirty();
            } else {
              setThisinhPath(path);
              void handleFetchContestants(path);
              markContestDirty();
            }
            setLoadModal(null);
          }}
          onLoad={() => {
            if (loadModal === "tests") {
              setTestPath(modalPath);
              void handleFetchProblems(modalPath);
              markContestDirty();
            } else {
              setThisinhPath(modalPath);
              void handleFetchContestants(modalPath);
              markContestDirty();
            }
            setLoadModal(null);
          }}
        />
      )}

      {actionMenu && (
        <EntityActionMenu
          target={actionMenu}
          mutationsLocked={interactionLocked}
          onClose={() => setActionMenu(null)}
          onConfig={() => {
            if (actionMenu.problemName) setActiveConfigProblem(actionMenu.problemName);
            setActionMenu(null);
          }}
          onDelete={() => {
            if (actionMenu.type === "result" && actionMenu.contestantName && actionMenu.problemName) {
              setPendingScoreDeletion({
                type: "result",
                contestantName: actionMenu.contestantName,
                problemName: actionMenu.problemName,
              });
            } else if (actionMenu.type === "problem" && actionMenu.problemName) {
              setPendingScoreDeletion({ type: "problem", problemName: actionMenu.problemName });
            } else if (actionMenu.contestantName) {
              setPendingScoreDeletion({ type: "contestant", contestantName: actionMenu.contestantName });
            }
            setActionMenu(null);
          }}
          onRegrade={() => {
            let request: Promise<void> | undefined;
            if (actionMenu.type === "result" && actionMenu.contestantName && actionMenu.problemName) {
              request = runJudge([actionMenu.contestantName], [actionMenu.problemName]);
            } else if (actionMenu.type === "problem" && actionMenu.problemName) {
              request = runJudge(
                    displayedContestants.filter(
                      (name) => selectedContestants[name],
                    ),
                    [actionMenu.problemName],
                  );
            } else if (actionMenu.contestantName) {
              request = runJudge(
                    [actionMenu.contestantName],
                    displayedProblems.filter((name) => selectedProblems[name]),
                  );
            }
            setActionMenu(null);
            if (request) void request;
          }}
          onDetails={() => {
            if (actionMenu.type === "result" && actionMenu.contestantName && actionMenu.problemName) {
              const problem = findProblemResult(actionMenu.contestantName, actionMenu.problemName);
              if (problem) setActiveDetails({ cont: actionMenu.contestantName, data: problem });
            } else if (actionMenu.type === "problem" && actionMenu.problemName) {
              setActiveLog({ type: "problem", name: actionMenu.problemName });
            } else if (actionMenu.contestantName) {
              setActiveLog({ type: "contestant", name: actionMenu.contestantName });
            }
            setActionMenu(null);
          }}
        />
      )}

      {progressState && (
        <ProgressWindow
          currentContestant={progressState.contestant}
          currentProblem={progressState.problem}
          action={progressState.action}
          percent={progressState.percent}
          onTerminate={handleTerminate}
        />
      )}

      {activeConfigProblem && (
        <ProblemConfigModal
          problemName={activeConfigProblem}
          testPath={testPath}
          initialConfig={
            problemConfigs[activeConfigProblem] ||
            createDefaultProblemConfig(activeConfigProblem)
          }
          hasScoredResults={problemHasPositiveScore(judgeResult, activeConfigProblem)}
          onSave={(problemName, config) => {
            saveProblemConfig(problemName, config);
            dispatchResults({ type: "delete_problem", problemName });
          }}
          onClose={() => setActiveConfigProblem(null)}
          customCheckers={customCheckersMap[activeConfigProblem] || []}
          saveDisabled={interactionLocked}
        />
      )}

      {activeDetails && (
        <JudgingDetailsModal
          contestantName={activeDetails.cont}
          data={activeDetails.data}
          onClose={() => setActiveDetails(null)}
        />
      )}

      {activeLog && (
        <ScoringLogModal
          title={t("scoringLog.entityDetails", {
            type: t(
              activeLog.type === "problem"
                ? "scoringLog.entityProblem"
                : "scoringLog.entityContestant",
            ),
            name: activeLog.name,
          })}
          contestants={judgeResult?.contestants ?? []}
          problemName={
            activeLog.type === "problem" ? activeLog.name : undefined
          }
          contestantName={
            activeLog.type === "contestant" ? activeLog.name : undefined
          }
          onClose={() => setActiveLog(null)}
        />
      )}

      {helpSection && (
        <HelpCenter
          initialSection={helpSection}
          hostStatus={hostStatus}
          workspacePaths={{
            problems: testPath,
            contestants: thisinhPath,
          }}
          loadToolchains={loadHelpToolchains}
          onClose={() => setHelpSection(null)}
          onOpenToolchains={() => {
            setHelpSection(null);
            setOpenToolchains(true);
          }}
        />
      )}

      {openToolchains && (
        <ToolchainManager
          onClose={() => setOpenToolchains(false)}
        />
      )}

      {pendingContestAction && (
        <UnsavedContestDialog
          isSaving={isSavingContest}
          onCancel={() => setPendingContestAction(null)}
          onDiscard={() => {
            void continuePendingAction(false);
          }}
          onSave={() => {
            void continuePendingAction(true);
          }}
        />
      )}

      {pendingScoreDeletion && (
        <ScoreDeleteConfirmDialog
          description={pendingScoreDeletionDescription}
          disabled={interactionLocked}
          onCancel={() => setPendingScoreDeletion(null)}
          onConfirm={confirmScoreDeletion}
        />
      )}

      {isSavingContest && <ContestSaveProgressDialog />}
      </div>

      {showUpdateChoices && updater.state.status === "available" && (
        <UpdateEditionDialog
          version={updater.state.version}
          currentEdition={updater.state.currentEdition}
          candidates={updater.state.candidates}
          onCancel={() => setShowUpdateChoices(false)}
          onChoose={(edition) => {
            if (!requiresEditionChange(updater.state.currentEdition, edition)) {
              setShowUpdateChoices(false);
              void updater.downloadUpdate(edition);
              return;
            }
            setShowUpdateChoices(false);
            setPendingUpdateEdition(edition);
          }}
        />
      )}

      {pendingUpdateEdition && updater.state.status === "available" && (
        <UpdateEditionChangeDialog
          currentEdition={updater.state.currentEdition}
          candidate={updater.state.candidates[pendingUpdateEdition]}
          onCancel={() => {
            setPendingUpdateEdition(null);
            setShowUpdateChoices(true);
          }}
          onConfirm={() => {
            const edition = pendingUpdateEdition;
            setPendingUpdateEdition(null);
            void updater.downloadUpdate(edition);
          }}
        />
      )}

      {showDonationConfirm && (
        <DonationConfirmDialog
          onCancel={() => setShowDonationConfirm(false)}
          onConfirm={() => {
            setShowDonationConfirm(false);
            void (async () => {
              try {
                if ("__TAURI_INTERNALS__" in window) {
                  const { openUrl } = await import("@tauri-apps/plugin-opener");
                  await openUrl(DONATION_QR_URL);
                } else {
                  window.open(DONATION_QR_URL, "_blank", "noopener,noreferrer");
                }
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : String(error));
              }
            })();
          }}
        />
      )}

      {showInstallUpdate && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-update-title"
            className="w-full max-w-md overflow-hidden rounded-lg border border-surface-border bg-surface shadow-2xl"
          >
            <div className="border-b border-surface-border bg-surface-elevated px-5 py-4">
              <h2 id="install-update-title" className="text-sm font-bold text-text-primary">
                {t("updates.installTitle")}
              </h2>
            </div>
            <div className="px-5 py-5 text-sm leading-6 text-text-muted">
              <p>
                {updateRequiresRestart
                  ? t("updates.restartRequired")
                  : t("updates.installMessage")}
              </p>
              {updateRequiresRestart && (
                <p className="mt-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
                  {updateRestartError ||
                    (updater.state.status === "error"
                      ? updater.state.message
                      : "")}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-surface-border bg-surface-elevated px-5 py-4">
              {updateRequiresRestart ? (
                <button
                  type="button"
                  disabled={isInstallingUpdate}
                  onClick={async () => {
                    setIsInstallingUpdate(true);
                    setUpdateRestartError("");
                    try {
                      const { relaunch } = await import("@tauri-apps/plugin-process");
                      await relaunch();
                    } catch (error) {
                      setUpdateRestartError(
                        error instanceof Error ? error.message : String(error),
                      );
                    } finally {
                      setIsInstallingUpdate(false);
                    }
                  }}
                  className="rounded bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60"
                >
                  {isInstallingUpdate
                    ? t("updates.restarting")
                    : t("updates.restartNow")}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={isInstallingUpdate}
                    onClick={() => setShowInstallUpdate(false)}
                    className="rounded border border-surface-border bg-input-bg px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover disabled:opacity-50"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={isInstallingUpdate}
                    onClick={async () => {
                      setIsInstallingUpdate(true);
                      setUpdateRestartError("");
                      try {
                        if (isJudging) await handleTerminate();
                        await updater.installUpdate();
                      } finally {
                        setIsInstallingUpdate(false);
                      }
                    }}
                    className="rounded bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60"
                  >
                    {isInstallingUpdate
                      ? t("updates.installing")
                      : t("updates.installNow")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
