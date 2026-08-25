import React, { useCallback, useEffect, useState, useMemo, useRef, useReducer } from "react";
import { FolderOpen, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "./api.js";
import { type HostStatus, type ProblemResult } from "./types.js";
import ProblemConfigModal from "./components/ProblemConfigModal.js";
import ProgressWindow from "./components/ProgressWindow.js";
import JudgingDetailsModal from "./components/JudgingDetailsModal.js";
import ScoringLogModal from "./components/ScoringLogModal.js";
import DirectoryPickerModal from "./components/DirectoryPickerModal.js";
import EntityActionMenu from "./components/EntityActionMenu.js";
import AppToolbar from "./components/AppToolbar.js";
import HelpCenter, { isHelpShortcut, type HelpSectionId } from "./features/help/HelpCenter.js";
import ToolchainManager from "./features/toolchains/ToolchainManager.js";
import ThemisToolchainPromptModal, {
  type DetectedThemisToolchain,
  type ManagedToolchainInfo,
} from "./features/toolchains/ThemisToolchainPromptModal.js";
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
import UnsavedContestDialog from "./components/UnsavedContestDialog.js";
import ScoreDeleteConfirmDialog from "./components/ScoreDeleteConfirmDialog.js";
import ContestSaveProgressDialog from "./components/ContestSaveProgressDialog.js";
import OsdSettingsModal from "./features/osd/OsdSettingsModal.js";
import { useOsdSession } from "./features/osd/useOsdSession.js";
import AppErrorToast from "./components/AppErrorToast.js";
import { formatAppError, type AppError } from "./features/errors/app-error.js";
import ChangelogModal from "./features/changelog/ChangelogModal.js";
import { preferencesStorage } from "./features/preferences/storage.js";
import { APP_VERSION } from "./version.js";
import { isMacOS } from "./features/shortcuts/shortcuts.js";
import { createDefaultProblemConfig } from "../shared/problem-config.js";
import {
  judgeResultsReducer,
  problemHasPositiveScore,
  type JudgeResultsAction,
} from "./features/judging/judge-results.js";
import {
  canExportScoreboard,
  canStartJudge,
  selectedNames,
} from "./features/judging/availability.js";
import { useJudgeSession } from "./features/judging/useJudgeSession.js";
import { useContestWorkspace } from "./features/workspace/useContestWorkspace.js";
import Scoreboard, {
  type ScoreboardActionTarget,
} from "./features/scoreboard/Scoreboard.js";
import { useScoreDeletion } from "./features/scores/useScoreDeletion.js";
import { useScoreboardExport } from "./features/export/useScoreboardExport.js";
import { useContestFileActions } from "./features/contest/useContestFileActions.js";
import { useAppShortcuts } from "./features/shortcuts/useAppShortcuts.js";

const DONATION_QR_URL = "https://img.vietqr.io/image/MB-0835385259-compact.png?amount=&addInfo=JudgeDesk%20Donation";

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
    addContestant,
  } = useContestWorkspace();

  const [searchTerm, setSearchTerm] = useState<string>("");
  const [contestantSort, setContestantSort] = useState<
    "default" | "asc" | "desc" | "score"
  >("default");
  const [problemSort, setProblemSort] = useState<"default" | "asc" | "desc">(
    "default",
  );

  // Active target in scoreboard
  const [activeContestant, setActiveContestant] = useState<string | null>(null);
  const [activeProblem, setActiveProblem] = useState<string | null>(null);

  // Modals
  const [activeConfigProblem, setActiveConfigProblem] = useState<string | null>(null);
  const [activeDetails, setActiveDetails] = useState<{
    cont: string;
    data: ProblemResult;
  } | null>(null);
  const [activeLog, setActiveLog] = useState<{
    type: "problem" | "contestant";
    name: string;
  } | null>(null);
  const [actionMenu, setActionMenu] = useState<ScoreboardActionTarget | null>(null);
  const [loadModal, setLoadModal] = useState<"tests" | "contestants" | null>(null);
  const [modalPath, setModalPath] = useState<string>("");
  const [openToolchains, setOpenToolchains] = useState(false);
  const [showOsdModal, setShowOsdModal] = useState(false);
  const [helpSection, setHelpSection] = useState<HelpSectionId | null>(null);
  const [showInstallUpdate, setShowInstallUpdate] = useState(false);
  const [showUpdateChoices, setShowUpdateChoices] = useState(false);
  const [pendingUpdateEdition, setPendingUpdateEdition] = useState<UpdateEdition | null>(null);
  const [showDonationConfirm, setShowDonationConfirm] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateRestartError, setUpdateRestartError] = useState("");
  const [showChangelog, setShowChangelog] = useState(false);
  const [showThemisPromptModal, setShowThemisPromptModal] = useState(false);
  const [themisDetectedToolchains, setThemisDetectedToolchains] = useState<DetectedThemisToolchain[]>([]);
  const [managedToolchainsInfo, setManagedToolchainsInfo] = useState<ManagedToolchainInfo[]>([]);

  // Host & Error states
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [backendErrorMessage, setBackendErrorMessage] = useState("");
  const [appError, setAppError] = useState<AppError | null>(null);
  const hostStatusRequestRef = useRef<Promise<void> | null>(null);

  const showError = useCallback((err: unknown, options?: Parameters<typeof formatAppError>[1]) => {
    setAppError(formatAppError(err, options, t));
  }, [t]);

  const clearError = useCallback(() => {
    setAppError(null);
    setBackendErrorMessage("");
  }, []);

  // App Updater
  const updater = useAppUpdater();

  useEffect(() => {
    const lastSeen = preferencesStorage.getLastSeenVersion();
    if (lastSeen !== APP_VERSION) {
      setShowChangelog(true);
    }
  }, []);

  const handleCloseChangelog = useCallback(() => {
    preferencesStorage.setLastSeenVersion(APP_VERSION);
    setShowChangelog(false);
  }, []);

  const updateRequiresRestart =
    updater.state.status === "error" &&
    (updater.state.phase === "prepare" ||
      updater.state.phase === "install" ||
      updater.state.phase === "relaunch");
  const updateHandoffActive = isInstallingUpdate || updateRequiresRestart;

  // Results State
  const [judgeResult, dispatchJudgeResults] = useReducer(
    judgeResultsReducer,
    null,
  );

  // Contest File Actions hook
  const {
    contestFilePath,
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
  } = useContestFileActions({
    contestantsList,
    problemsList,
    problemConfigs,
    selectedContestants,
    selectedProblems,
    judgeResult,
    thisinhPath,
    testPath,
    updater,
    isLocked: () => isJudging || isSavingContest || updateHandoffActive,
    onResetWorkspace: resetWorkspace,
    onRestoreWorkspace: restoreWorkspace,
    dispatchJudgeResults,
    onClearErrors: () => {
      clearError();
      setErrorMessage("");
    },
    setErrorMessage: (msg) => setErrorMessage(msg),
    showError,
    onResetFilters: useCallback(() => {
      setSearchTerm("");
      setContestantSort("default");
      setProblemSort("default");
    }, []),
  });

  const dispatchResults = useCallback((action: JudgeResultsAction) => {
    dispatchJudgeResults(action);
    if (action.type !== "replace") markContestDirty();
  }, [markContestDirty]);

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

  // Judging Session Hook
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

  // OSD Session Hook
  const {
    status: osdStatus,
    startOsd,
    stopOsd,
  } = useOsdSession({
    contestantsPath: thisinhPath,
    testPath,
    problemConfigs,
    onContestantDiscovered: (contestant) => {
      addContestant(contestant);
    },
    onProblemCompleted: (contestant, problemResult) => {
      addContestant(contestant);
      dispatchResults({
        type: "merge_problem",
        contestant,
        problemResult,
      });
    },
  });

  const interactionLocked =
    isJudging || isSavingContest || updateHandoffActive;

  useEffect(() => {
    if (errorMessage) {
      showError(errorMessage);
    }
  }, [errorMessage, showError]);

  // Sorting and Filtering
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

  // Host status loader
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
        showError(error, { code: "BACKEND_CONNECTION" });
      } finally {
        hostStatusRequestRef.current = null;
      }
    })();
    hostStatusRequestRef.current = request;
  }, [showError, t]);

  const loadHelpToolchains = useCallback(async (): Promise<ToolchainState> => {
    const response = await apiFetch("/api/toolchains");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as ToolchainState;
  }, []);

  useEffect(() => {
    requestHostStatus();
  }, [requestHostStatus]);

  // Themis Toolchain Detection Prompt on First Launch
  useEffect(() => {
    if (preferencesStorage.hasThemisPromptChoice()) return;

    let isMounted = true;
    const checkThemisDetection = async () => {
      try {
        const response = await apiFetch("/api/toolchains");
        if (!response.ok) return;
        const data = (await response.json()) as ToolchainState;
        if (!isMounted) return;

        const detected: DetectedThemisToolchain[] = [];
        for (const profile of data.profiles || []) {
          const themisCandidate = profile.candidates?.find(
            (c) =>
              c.canonicalPath.toLowerCase().includes("themis") ||
              c.displayPath.toLowerCase().includes("themis"),
          );
          if (themisCandidate) {
            const langName =
              profile.kind === "cpp"
                ? "C++ (g++)"
                : profile.kind === "c"
                  ? "C (gcc)"
                  : profile.kind === "pascal"
                    ? "Pascal (fpc)"
                    : profile.kind === "python"
                      ? "Python"
                      : profile.kind === "java"
                        ? "Java (javac)"
                        : profile.displayNameKey || profile.kind;
            detected.push({
              profileId: profile.id,
              kind: profile.kind,
              name: langName,
              path: themisCandidate.canonicalPath,
              version: profile.active?.version || undefined,
            });
          }
        }

        const managed: ManagedToolchainInfo[] = (data.profiles || [])
          .filter((p) => ["cpp", "c", "pascal", "python", "java"].includes(p.kind))
          .map((p) => {
            const langName =
              p.kind === "cpp"
                ? "C++ (g++)"
                : p.kind === "c"
                  ? "C (gcc)"
                  : p.kind === "pascal"
                    ? "Pascal (fpc)"
                    : p.kind === "python"
                      ? "Python"
                      : p.kind === "java"
                        ? "Java (javac)"
                        : p.displayNameKey || p.kind;
            const ver =
              p.managedPackage?.version ||
              (p.kind === "cpp" || p.kind === "c"
                ? "14.2.0"
                : p.kind === "pascal"
                  ? "3.2.2"
                  : p.kind === "python"
                    ? "3.12.0"
                    : "21.0.12");
            return {
              profileId: p.id,
              kind: p.kind,
              name: langName,
              version: ver,
            };
          });

        if (detected.length > 0 && isMounted) {
          setThemisDetectedToolchains(detected);
          setManagedToolchainsInfo(managed);
          setShowThemisPromptModal(true);
        }
      } catch (err) {
        console.warn("Failed to probe Themis toolchains:", err);
      }
    };

    void checkThemisDetection();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleApplyThemisAll = useCallback(async () => {
    for (const item of themisDetectedToolchains) {
      try {
        await apiFetch(`/api/toolchains/profiles/${encodeURIComponent(item.profileId)}/preference`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "local_path",
            localPath: item.path,
          }),
        });
      } catch (err) {
        console.error(`Failed to set Themis toolchain for ${item.profileId}:`, err);
      }
    }
    requestHostStatus();
  }, [themisDetectedToolchains, requestHostStatus]);

  const handleApplyManagedAll = useCallback(async () => {
    for (const item of managedToolchainsInfo) {
      try {
        await apiFetch(`/api/toolchains/profiles/${encodeURIComponent(item.profileId)}/preference`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "managed",
          }),
        });
      } catch (err) {
        console.error(`Failed to set managed toolchain for ${item.profileId}:`, err);
      }
    }
    requestHostStatus();
  }, [managedToolchainsInfo, requestHostStatus]);

  const handleThemisSuccessToast = useCallback((msg: string) => {
    setAppError({
      title: t("common.success", "Thành công"),
      reason: msg,
      severity: "info",
    });
  }, [t]);

  const handleReloadFolders = useCallback(async () => {
    try {
      const [loadedContestants, loadedProblems] = await Promise.all([
        handleFetchContestants(undefined, { preserveSelection: true }),
        handleFetchProblems(undefined, { preserveSelection: true }),
      ]);
      markContestDirty();
      if (thisinhPath && loadedContestants.length === 0) {
        showError(null, { code: "DIRECTORY_EMPTY" });
      } else if (testPath && loadedProblems.length === 0) {
        showError(null, { code: "DIRECTORY_EMPTY" });
      }
    } catch (error) {
      showError(error);
    }
  }, [handleFetchContestants, handleFetchProblems, markContestDirty, showError, testPath, thisinhPath]);

  // Score Deletion Hook
  const {
    pendingScoreDeletion,
    setPendingScoreDeletion,
    pendingScoreDeletionDescription,
    confirmScoreDeletion,
  } = useScoreDeletion({
    dispatchResults,
    isLocked: () => interactionLocked || isSavingContest,
  });

  // Scoreboard Export Hook
  const {
    isExporting,
    handleExport,
  } = useScoreboardExport({
    displayedProblems,
    displayedContestants,
    selectedProblems,
    selectedContestants,
    problemsList,
    contestantsList,
    judgeResult,
    hostStatus,
    isLocked: () => interactionLocked || isSavingContest,
    onClearErrors: () => {
      setErrorMessage("");
      setAppError(null);
    },
    showError,
  });

  const runJudge = (
    contestantsOverride?: string[],
    problemsOverride?: string[],
  ) => {
    if (interactionLocked || isSavingContest) return Promise.resolve();
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

  const findProblemResult = (contestantName: string, problemName: string) =>
    judgeResult?.contestants
      .find((contestant) => contestant.contestantName === contestantName)
      ?.problems.find(
        (problem) => problem.problemName.toLowerCase() === problemName.toLowerCase(),
      );

  // App Keyboard Shortcuts Hook: if (!isHelpShortcut(event)) ...
  useAppShortcuts({
    hostStatus,
    updateHandoffActive,
    interactionLocked,
    canRun,
    contestantsList,
    problemsList,
    displayedContestants,
    displayedProblems,
    activeContestant,
    activeProblem,
    testsPickerPath,
    contestantsPickerPath,
    isContestDirty,
    hasContestData,

    actionMenu,
    activeDetails,
    activeConfigProblem,
    activeLog,
    loadModal,
    helpSection,
    openToolchains,
    showOsdModal,
    pendingScoreDeletion,
    pendingContestAction,

    onCloseActionMenu: () => setActionMenu(null),
    onCloseActiveDetails: () => setActiveDetails(null),
    onCloseActiveConfigProblem: () => setActiveConfigProblem(null),
    onCloseActiveLog: () => setActiveLog(null),
    onCloseLoadModal: () => setLoadModal(null),
    onCloseHelpSection: () => setHelpSection(null),
    onCloseOpenToolchains: () => setOpenToolchains(false),
    onCloseShowOsdModal: () => setShowOsdModal(false),
    onClosePendingScoreDeletion: () => setPendingScoreDeletion(null),
    onClosePendingContestAction: () => setPendingContestAction(null),

    onOpenLoadModal: (kind, defaultPath) => {
      setLoadModal(kind);
      setModalPath(defaultPath);
    },
    onReloadFolders: () => void handleReloadFolders(),
    onOpenToolchains: () => setOpenToolchains(true),
    onToggleOsd: () => setShowOsdModal((prev) => !prev),
    onRunJudge: () => void runJudge(),
    onExportExcel: handleExport,
    onRequestContestAction: requestContestAction,
    onSaveContest: (forceSaveAs) => void handleSaveContest(forceSaveAs),
    onOpenHelp: () => setHelpSection((current) => current ?? "quick-start"),

    onSelectAllContestants: () => {
      setSelectedContestants((prev) => ({
        ...prev,
        ...Object.fromEntries(contestantsList.map((name) => [name, true])),
      }));
      markContestDirty();
    },
    onDeselectAllContestants: () => {
      setSelectedContestants((prev) => ({
        ...prev,
        ...Object.fromEntries(contestantsList.map((name) => [name, false])),
      }));
      markContestDirty();
    },
    onToggleActiveContestant: (target) => {
      setSelectedContestants((prev) => ({
        ...prev,
        [target]: !prev[target],
      }));
      markContestDirty();
    },
    onSelectAllProblems: () => {
      setSelectedProblems((prev) => ({
        ...prev,
        ...Object.fromEntries(problemsList.map((name) => [name, true])),
      }));
      markContestDirty();
    },
    onDeselectAllProblems: () => {
      setSelectedProblems((prev) => ({
        ...prev,
        ...Object.fromEntries(problemsList.map((name) => [name, false])),
      }));
      markContestDirty();
    },
    onToggleActiveProblem: (target) => {
      setSelectedProblems((prev) => ({
        ...prev,
        [target]: !prev[target],
      }));
      markContestDirty();
    },
  });

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
          osdStatus={osdStatus}
          onOpenOsd={() => setShowOsdModal(true)}
          onDeleteSelected={() => {
            setPendingScoreDeletion({
              type: "selected",
              contestantNames: selectedContestantNames,
              problemNames: selectedProblemNames,
            });
          }}
          onExport={handleExport}
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
            void handleReloadFolders();
          }}
          onRun={() => {
            void runJudge();
          }}
          onSaveContest={() => {
            void handleSaveContest(false);
          }}
          onOpenHelp={() => setHelpSection("quick-start")}
          onOpenDonation={() => setShowDonationConfirm(true)}
          onOpenToolchains={() => setOpenToolchains(true)}
          onRequestHostStatus={requestHostStatus}
          updateState={updater.state}
          onCheckUpdates={() => void updater.checkForUpdates()}
          onOpenUpdateChoices={() => {
            if (updater.state.status === "available") {
              void updater.downloadUpdate("core");
            }
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
          activeContestant={activeContestant}
          activeProblem={activeProblem}
          onActiveTargetChange={(contestant, problem) => {
            setActiveContestant(contestant);
            setActiveProblem(problem);
          }}
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
            onDropPath={async (path) => {
              try {
                if (loadModal === "tests") {
                  setTestPath(path);
                  const loaded = await handleFetchProblems(path);
                  markContestDirty();
                  if (loaded.length === 0) {
                    showError(null, { code: "DIRECTORY_EMPTY" });
                  } else {
                    setAppError(null);
                  }
                } else {
                  setThisinhPath(path);
                  const loaded = await handleFetchContestants(path);
                  markContestDirty();
                  if (loaded.length === 0) {
                    showError(null, { code: "DIRECTORY_EMPTY" });
                  } else {
                    setAppError(null);
                  }
                }
              } catch (error) {
                showError(error);
              }
              setLoadModal(null);
            }}
            onLoad={async () => {
              try {
                if (loadModal === "tests") {
                  setTestPath(modalPath);
                  const loaded = await handleFetchProblems(modalPath);
                  markContestDirty();
                  if (loaded.length === 0) {
                    showError(null, { code: "DIRECTORY_EMPTY" });
                  } else {
                    setAppError(null);
                  }
                } else {
                  setThisinhPath(modalPath);
                  const loaded = await handleFetchContestants(modalPath);
                  markContestDirty();
                  if (loaded.length === 0) {
                    showError(null, { code: "DIRECTORY_EMPTY" });
                  } else {
                    setAppError(null);
                  }
                }
              } catch (error) {
                showError(error);
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
                  displayedContestants.filter((name) => selectedContestants[name]),
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
            onOpenChangelog={() => {
              setHelpSection(null);
              setShowChangelog(true);
            }}
          />
        )}

        {openToolchains && (
          <ToolchainManager
            onClose={() => setOpenToolchains(false)}
          />
        )}

        {showThemisPromptModal && (
          <ThemisToolchainPromptModal
            isOpen={showThemisPromptModal}
            onClose={() => setShowThemisPromptModal(false)}
            themisToolchains={themisDetectedToolchains}
            managedToolchains={managedToolchainsInfo}
            onApplyManaged={handleApplyManagedAll}
            onApplyThemis={handleApplyThemisAll}
            onSuccessToast={handleThemisSuccessToast}
          />
        )}

        {showOsdModal && (
          <OsdSettingsModal
            status={osdStatus}
            contestantsPath={thisinhPath}
            testPath={testPath}
            onStart={startOsd}
            onStop={stopOsd}
            onClose={() => setShowOsdModal(false)}
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
              if (edition) void updater.downloadUpdate(edition);
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
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-surface-border bg-surface shadow-2xl">
              <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated px-5 py-4">
                <h3 className="text-sm font-bold text-text-primary">
                  {updateRequiresRestart
                    ? t("updates.restartNow")
                    : t("updates.installTitle")}
                </h3>
                {!isInstallingUpdate && (
                  <button
                    type="button"
                    onClick={() => setShowInstallUpdate(false)}
                    className="p-1 text-text-muted hover:text-text-primary"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="p-5 text-xs text-text-muted">
                {updateRequiresRestart
                  ? t("updates.restartRequired")
                  : t("updates.installMessage")}
                {updateRestartError && (
                  <p className="mt-2 text-rose-500">
                    {updateRestartError}
                    {updateRestartError.includes("failed to spawn")
                      ? " " +
                        (isMacOS(hostStatus?.platform)
                          ? t("updates.relaunchFailedHintMac")
                          : t("updates.relaunchFailedHintWindows"))
                      : (isMacOS(hostStatus?.platform)
                        ? " " + t("updates.relaunchGenericHintMac")
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

        {showChangelog && (
          <ChangelogModal onClose={handleCloseChangelog} />
        )}

        {isWindowDragging && !loadModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md pointer-events-none transition-all duration-300">
            <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-indigo-500 bg-surface/95 px-12 py-10 shadow-2xl ring-4 ring-indigo-500/20 max-w-lg text-center animate-in fade-in zoom-in-95 duration-200">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-500 dark:text-indigo-400">
                <FolderOpen className="h-9 w-9 animate-bounce" />
              </div>
              <div>
                <h3 className="text-base font-bold text-text-primary">
                  {t("contest.dropToOpenTitle", "Thả file kỳ thi .judgedesk hoặc thư mục")}
                </h3>
                <p className="mt-1 text-xs text-text-muted">
                  {t(
                    "contest.dropToOpenSubtitle",
                    "Mở kỳ thi đã lưu kèm đề bài, thí sinh và kết quả chấm",
                  )}
                </p>
              </div>
            </div>
          </div>
        )}

        <AppErrorToast error={appError} onClose={clearError} />
      </div>
    </div>
  );
}
