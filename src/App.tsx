import React, { useCallback, useEffect, useState, useMemo, useRef, useReducer } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "./api.js";
import { type HostStatus, type ProblemResult } from "./types.js";
import AppToolbar from "./components/AppToolbar.js";
import AppModals from "./components/AppModals.js";
import { isHelpShortcut, type HelpSectionId } from "./features/help/HelpCenter.js";
import { useThemisPromptModal } from "./features/toolchains/useThemisPromptModal.js";
import { useScratchPromptModal } from "./features/toolchains/useScratchPromptModal.js";
import type { ToolchainState } from "./features/toolchains/useToolchains.js";
import { createHostStatusRefresh } from "./features/toolchains/host-status-refresh.js";
import { useAppUpdater } from "./features/updates/useAppUpdater.js";
import { type UpdateEdition } from "./features/updates/catalog.js";
import { useOsdSession } from "./features/osd/useOsdSession.js";
import { formatAppError, type AppError } from "./features/errors/app-error.js";
import { preferencesStorage } from "./features/preferences/storage.js";
import { APP_VERSION } from "./version.js";
import {
  judgeResultsReducer,
  type JudgeResultsAction,
} from "./features/judging/judge-results.js";
import {
  canExportScoreboard,
  canStartJudge,
  getJudgeDisabledReason,
  selectedNames,
} from "./features/judging/availability.js";
import { useJudgeSession } from "./features/judging/useJudgeSession.js";
import { useContestWorkspace } from "./features/workspace/useContestWorkspace.js";
import Scoreboard, {
  type ScoreboardActionTarget,
} from "./features/scoreboard/Scoreboard.js";
import {
  hasAnyContestantScore,
  sortContestants,
  type ContestantSortMode,
} from "./features/scoreboard/scoreboard-model.js";
import { useScoreDeletion } from "./features/scores/useScoreDeletion.js";
import { useScoreboardExport } from "./features/export/useScoreboardExport.js";
import { useContestFileActions } from "./features/contest/useContestFileActions.js";
import { useAppShortcuts } from "./features/shortcuts/useAppShortcuts.js";

export default function App() {
  const { t } = useTranslation();
  const {
    contestants: contestantsList,
    contestantsPath: thisinhPath,
    contestantsPickerPath,
    customCheckers: customCheckersMap,
    interactors: interactorsMap,
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
  const [contestantSort, setContestantSort] = useState<ContestantSortMode>("default");
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

  // Host & Error states
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [appError, setAppError] = useState<AppError | null>(null);
  const hostStatusRefreshRef = useRef<ReturnType<typeof createHostStatusRefresh> | null>(null);

  const showError = useCallback((err: unknown, options?: Parameters<typeof formatAppError>[1]) => {
    setAppError(formatAppError(err, options, t));
  }, [t]);

  const clearError = useCallback(() => {
    setAppError(null);
  }, []);

  // App Updater
  const updater = useAppUpdater();

  const handleCheckUpdates = useCallback(async () => {
    const outcome = await updater.checkForUpdates({ manual: true });
    if (outcome.status === "current") {
      setAppError({
        title: t("updates.upToDate"),
        reason: t("updates.upToDateDetails", { version: APP_VERSION }),
        severity: "info",
      });
    } else if (outcome.status === "error") {
      setAppError({
        title: t("updates.checkFailed"),
        reason: t("updates.checkFailedNetwork"),
        severity: "warning",
      });
    }
  }, [updater, t]);

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

  const orderedContestants = useMemo(
    () =>
      sortContestants(
        contestantsList,
        contestantSort,
        judgeResult,
        problemsList,
        selectedProblems,
      ),
    [
      contestantsList,
      contestantSort,
      judgeResult,
      problemsList,
      selectedProblems,
    ],
  );

  const displayedContestants = useMemo(() => {
    if (!searchTerm.trim()) return orderedContestants;
    const lower = searchTerm.toLowerCase();
    return orderedContestants.filter((contestant) => contestant.toLowerCase().includes(lower));
  }, [orderedContestants, searchTerm]);

  const canSortScores = useMemo(
    () =>
      hasAnyContestantScore(
        judgeResult,
        contestantsList,
        problemsList,
        selectedProblems,
      ),
    [judgeResult, contestantsList, problemsList, selectedProblems],
  );

  const handleToggleScoreSort = useCallback(() => {
    setContestantSort((previous) => {
      if (previous === "score" || previous === "score_desc") return "score_asc";
      if (previous === "score_asc") return "default";
      return "score_desc";
    });
  }, []);

  useEffect(() => {
    if (
      !canSortScores &&
      (contestantSort === "score" ||
        contestantSort === "score_desc" ||
        contestantSort === "score_asc")
    ) {
      setContestantSort("default");
    }
  }, [canSortScores, contestantSort]);

  // Host status loader
  const loadHelpToolchains = useCallback(async (): Promise<ToolchainState> => {
    const response = await apiFetch("/api/toolchains");
    return (await response.json()) as ToolchainState;
  }, []);

  const requestHostStatus = useCallback(() => {
    void hostStatusRefreshRef.current?.request();
  }, []);

  useEffect(() => {
    const refresh = createHostStatusRefresh({
      loadToolchains: loadHelpToolchains,
      loadHostStatus: async () => {
        const response = await apiFetch("/api/status");
        return (await response.json()) as HostStatus;
      },
      onStatus: setHostStatus,
      onError: (error) => showError(error, { code: "BACKEND_CONNECTION" }),
    });
    hostStatusRefreshRef.current = refresh;
    requestHostStatus();
    return () => {
      refresh.dispose();
      hostStatusRefreshRef.current = null;
    };
  }, [loadHelpToolchains, requestHostStatus, showError]);

  // Themis Toolchain Detection Prompt on First Launch
  const {
    showThemisPromptModal,
    setShowThemisPromptModal,
    themisDetectedToolchains,
    managedToolchainsInfo,
    handleApplyThemisAll,
    handleApplyManagedAll,
  } = useThemisPromptModal({
    onRefreshHostStatus: requestHostStatus,
  });

  // Scratch Toolchain Enable Prompt on v1.4.4 Launch
  const {
    showScratchPromptModal,
    setShowScratchPromptModal,
    handleEnableScratch,
  } = useScratchPromptModal({
    onRefreshHostStatus: requestHostStatus,
  });

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
  const judgeAvailability = {
    contestantsPath: thisinhPath,
    testsPath: testPath,
    contestantNames: selectedContestantNames,
    problemNames: selectedProblemNames,
    secureRunnerReady: hostStatus?.secureRunner.ready === true,
  };
  const canRun = canStartJudge(judgeAvailability);
  const runDisabledReason = getJudgeDisabledReason(judgeAvailability);
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
          runDisabledReason={runDisabledReason}
          canSaveContest={isContestDirty && hasContestData}
          canSortScores={canSortScores}
          scoreSortMode={contestantSort}
          onToggleScoreSort={handleToggleScoreSort}
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
          onCheckUpdates={handleCheckUpdates}
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
          canSortScores={canSortScores}
          onToggleScoreSort={handleToggleScoreSort}
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

        <AppModals
          loadModal={loadModal}
          modalPath={modalPath}
          actionMenu={actionMenu}
          progressState={progressState}
          activeConfigProblem={activeConfigProblem}
          activeDetails={activeDetails}
          activeLog={activeLog}
          helpSection={helpSection}
          openToolchains={openToolchains}
          showOsdModal={showOsdModal}
          pendingContestAction={pendingContestAction}
          pendingScoreDeletion={pendingScoreDeletion}
          pendingScoreDeletionDescription={pendingScoreDeletionDescription}
          isSavingContest={isSavingContest}
          showUpdateChoices={showUpdateChoices}
          pendingUpdateEdition={pendingUpdateEdition}
          showDonationConfirm={showDonationConfirm}
          showInstallUpdate={showInstallUpdate}
          showChangelog={showChangelog}
          showThemisPromptModal={showThemisPromptModal}
          themisDetectedToolchains={themisDetectedToolchains}
          managedToolchainsInfo={managedToolchainsInfo}
          showScratchPromptModal={showScratchPromptModal}
          isWindowDragging={isWindowDragging}
          appError={appError}
          hostStatus={hostStatus}
          judgeResult={judgeResult}
          testPath={testPath}
          thisinhPath={thisinhPath}
          problemConfigs={problemConfigs}
          customCheckersMap={customCheckersMap}
          interactorsMap={interactorsMap}
          interactionLocked={interactionLocked}
          updater={updater}
          osdStatus={osdStatus}
          updateRequiresRestart={updateRequiresRestart}
          updateRestartError={updateRestartError}
          isInstallingUpdate={isInstallingUpdate}
          isJudging={isJudging}
          onSetModalPath={setModalPath}
          onCloseLoadModal={() => setLoadModal(null)}
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
          onLoadPath={async () => {
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
          onCloseActionMenu={() => setActionMenu(null)}
          onOpenConfigProblem={(prob) => setActiveConfigProblem(prob)}
          onSetPendingScoreDeletion={setPendingScoreDeletion}
          onRunJudgeTargets={runJudge}
          onOpenResultDetails={(cont, data) => setActiveDetails({ cont, data })}
          onOpenLog={(log) => setActiveLog(log)}
          findProblemResult={findProblemResult}
          displayedContestants={displayedContestants}
          displayedProblems={displayedProblems}
          selectedContestants={selectedContestants}
          selectedProblems={selectedProblems}
          onTerminateJudging={handleTerminate}
          onSaveProblemConfig={saveProblemConfig}
          onDeleteProblemResults={(problemName) => dispatchResults({ type: "delete_problem", problemName })}
          onCloseConfigProblem={() => setActiveConfigProblem(null)}
          onCloseDetails={() => setActiveDetails(null)}
          onCloseLog={() => setActiveLog(null)}
          loadHelpToolchains={loadHelpToolchains}
          onCloseHelp={() => setHelpSection(null)}
          onOpenToolchainsFromHelp={() => {
            setHelpSection(null);
            setOpenToolchains(true);
          }}
          onOpenChangelogFromHelp={() => {
            setHelpSection(null);
            setShowChangelog(true);
          }}
          onCloseToolchains={() => setOpenToolchains(false)}
          onCloseThemisPrompt={() => setShowThemisPromptModal(false)}
          onApplyThemisAll={handleApplyThemisAll}
          onApplyManagedAll={handleApplyManagedAll}
          onThemisSuccessToast={handleThemisSuccessToast}
          onCloseScratchPrompt={() => setShowScratchPromptModal(false)}
          onEnableScratch={handleEnableScratch}
          onStartOsd={startOsd}
          onStopOsd={stopOsd}
          onCloseOsd={() => setShowOsdModal(false)}
          onCancelPendingContestAction={() => setPendingContestAction(null)}
          onContinuePendingContestAction={continuePendingAction}
          onCancelScoreDeletion={() => setPendingScoreDeletion(null)}
          onConfirmScoreDeletion={confirmScoreDeletion}
          onCloseUpdateChoices={() => setShowUpdateChoices(false)}
          onChooseUpdateEdition={(edition) => setPendingUpdateEdition(edition)}
          onCancelUpdateEditionChange={() => {
            setPendingUpdateEdition(null);
            setShowUpdateChoices(true);
          }}
          onConfirmUpdateEditionChange={() => {
            const edition = pendingUpdateEdition;
            setPendingUpdateEdition(null);
            if (edition) void updater.downloadUpdate(edition);
          }}
          onCloseDonationConfirm={() => setShowDonationConfirm(false)}
          onSetErrorMessage={(msg) => setErrorMessage(msg)}
          onCloseInstallUpdate={() => setShowInstallUpdate(false)}
          onRestartUpdate={async () => {
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
          onInstallUpdate={async () => {
            setIsInstallingUpdate(true);
            setUpdateRestartError("");
            try {
              if (isJudging) await handleTerminate();
              await updater.installUpdate();
            } finally {
              setIsInstallingUpdate(false);
            }
          }}
          onCloseChangelog={handleCloseChangelog}
          onClearError={clearError}
        />
      </div>
    </div>
  );
}
