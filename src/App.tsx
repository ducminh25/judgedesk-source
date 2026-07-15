import React, { useEffect, useState, useMemo, useRef, useReducer } from "react";
import { HostStatus, ProblemResult } from "./types";
import ProblemConfigModal from "./components/ProblemConfigModal";
import ProgressWindow from "./components/ProgressWindow";
import JudgingDetailsModal from "./components/JudgingDetailsModal";
import ScoringLogModal from "./components/ScoringLogModal";
import { apiFetch } from "./api";
import { buildScoreWorkbookBase64 } from "./features/export/score-workbook";
import { judgeResultsReducer } from "./features/judging/judge-results";
import { useJudgeSession } from "./features/judging/useJudgeSession";
import { useContestWorkspace } from "./features/workspace/useContestWorkspace";
import { createDefaultProblemConfig } from "../shared/problem-config";
import Scoreboard, {
  type ScoreboardActionTarget,
} from "./features/scoreboard/Scoreboard";
import DirectoryPickerModal from "./components/DirectoryPickerModal";
import EntityActionMenu from "./components/EntityActionMenu";
import AppToolbar from "./components/AppToolbar";
import { useTranslation } from "react-i18next";
import { ToolchainSetupModal } from "./features/toolchains/ToolchainSetupModal.js";
import { preferencesStorage } from "./features/preferences/storage.js";
import ToolchainManager from "./features/toolchains/ToolchainManager.js";

export default function App() {
  const { t } = useTranslation();
  const {
    contestants: contestantsList,
    contestantsPath: thisinhPath,
    customCheckers: customCheckersMap,
    loadContestants: handleFetchContestants,
    loadProblems: handleFetchProblems,
    problemConfigs,
    problems: problemsList,
    saveProblemConfig,
    selectedContestants,
    selectedProblems,
    setContestantsPath: setThisinhPath,
    setSelectedContestants,
    setSelectedProblems,
    setTestPath,
    setTimeLimit,
    testPath,
    timeLimit,
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
  const [openToolchainSetup, setOpenToolchainSetup] = useState(false);

  useEffect(() => {
    if (!preferencesStorage.isToolchainSetupCompleted()) {
      setOpenToolchainSetup(true);
    }
  }, []);

  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [backendErrorMessage, setBackendErrorMessage] = useState("");
  const [judgeResult, dispatchJudgeResults] = useReducer(
    judgeResultsReducer,
    null,
  );

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

  const displayedContestants = useMemo(() => {
    let list = contestantsList;
    if (searchTerm.trim()) {
      const lower = searchTerm.toLowerCase();
      list = list.filter((c) => c.toLowerCase().includes(lower));
    }

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
    searchTerm,
    contestantSort,
    judgeResult,
    selectedProblems,
    problemsList,
  ]);

  const activeLoadModalRef = useRef<"tests" | "contestants" | null>(null);

  useEffect(() => {
    const preventBrowserMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventBrowserMenu);

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;

    async function fetchStatus() {
      try {
        const response = await apiFetch("/api/status");
        const status = await response.json();
        if (cancelled) return;
        setHostStatus(status);
        setBackendErrorMessage("");
      } catch (error) {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 30) {
          console.error("Failed to load host status", error);
          setBackendErrorMessage(t("errors.backendConnection"));
        } else {
          console.log(
            `[API Retry] Backend is not ready yet (attempt ${consecutiveFailures}/30).`,
          );
        }

        // Keep checking after displaying the error so a slow backend can recover
        // without forcing the user to restart the desktop application.
        const retryDelay = consecutiveFailures >= 30 ? 5000 : 1000;
        retryTimer = setTimeout(fetchStatus, retryDelay);
      }
    }
    fetchStatus();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      document.removeEventListener("contextmenu", preventBrowserMenu);
    };
  }, [t]);

  useEffect(() => {
    activeLoadModalRef.current = loadModal;
    if (loadModal) {
      setModalPath(loadModal === "tests" ? testPath : thisinhPath);
    }
  }, [loadModal, testPath, thisinhPath]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function setupTauri() {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const appWebview = getCurrentWebview();
        unlisten = await appWebview.onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
              const absolutePath = paths[0];
              console.log("Tauri file drop event path:", absolutePath);

              const currentModal = activeLoadModalRef.current;
              if (currentModal === "tests") {
                setTestPath(absolutePath);
                handleFetchProblems(absolutePath);
                setLoadModal(null);
              } else if (currentModal === "contestants") {
                setThisinhPath(absolutePath);
                handleFetchContestants(absolutePath);
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
  }, []);

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
    timeLimit,
    problemConfigs,
    dispatchResults: dispatchJudgeResults,
  });

  const runJudge = (
    contestantsOverride?: string[],
    problemsOverride?: string[],
  ) => {
    const contestants =
      contestantsOverride ??
      displayedContestants.filter((name) => selectedContestants[name]);
    const problems =
      problemsOverride ??
      displayedProblems.filter((name) => selectedProblems[name]);
    return runJudgeTargets(contestants, problems);
  };

  const deleteProblemScore = (problemName: string) => {
    dispatchJudgeResults({ type: "delete_problem", problemName });
  };

  const deleteContestantScore = (contestantName: string) => {
    dispatchJudgeResults({ type: "delete_contestant", contestantName });
  };

  const handleExportExcel = async () => {
    if (!judgeResult) return;
    try {
      const activeProblems = displayedProblems.filter(
        (problem) => selectedProblems[problem],
      );
      const activeContestants = displayedContestants.filter(
        (contestant) => selectedContestants[contestant],
      );
      const workbookBase64 = await buildScoreWorkbookBase64(
        judgeResult,
        activeContestants,
        activeProblems,
        t,
      );
      await apiFetch("/api/open-excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workbookBase64 }),
      });
    } catch (error: any) {
      setErrorMessage(error.message || "Failed to open the Excel workbook.");
    }
  };

  return (
    <div
      id="local-online-judge"
      className="h-screen bg-surface text-text-primary font-sans flex flex-col overflow-hidden"
    >
      <AppToolbar
        errorMessage={backendErrorMessage || errorMessage}
        hostStatus={hostStatus}
        isJudging={isJudging}
        timeLimit={timeLimit}
        onOpenContestants={() => {
          setLoadModal("contestants");
          setModalPath(thisinhPath);
        }}
        onOpenTests={() => {
          setLoadModal("tests");
          setModalPath(testPath);
        }}
        onReload={() => {
          void handleFetchContestants();
          void handleFetchProblems();
        }}
        onRun={() => {
          void runJudge();
        }}
        onTimeLimitChange={setTimeLimit}
        onOpenToolchains={() => setOpenToolchains(true)}
      />

      <Scoreboard
        allContestants={contestantsList}
        contestants={displayedContestants}
        contestantSort={contestantSort}
        problems={displayedProblems}
        result={judgeResult}
        selectedContestants={selectedContestants}
        selectedProblems={selectedProblems}
        setContestantSort={setContestantSort}
        setSelectedContestants={setSelectedContestants}
        setSelectedProblems={setSelectedProblems}
        onExport={handleExportExcel}
        onOpenActions={setActionMenu}
        onOpenDetails={(cont, data) => setActiveDetails({ cont, data })}
      />

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
            } else {
              setThisinhPath(path);
              void handleFetchContestants(path);
            }
            setLoadModal(null);
          }}
          onLoad={() => {
            if (loadModal === "tests") {
              setTestPath(modalPath);
              void handleFetchProblems(modalPath);
            } else {
              setThisinhPath(modalPath);
              void handleFetchContestants(modalPath);
            }
            setLoadModal(null);
          }}
        />
      )}

      {actionMenu && (
        <EntityActionMenu
          target={actionMenu}
          isJudging={isJudging}
          onClose={() => setActionMenu(null)}
          onConfig={() => {
            setActiveConfigProblem(actionMenu.name);
            setActionMenu(null);
          }}
          onDelete={() => {
            if (actionMenu.type === "problem")
              deleteProblemScore(actionMenu.name);
            else deleteContestantScore(actionMenu.name);
            setActionMenu(null);
          }}
          onRegrade={() => {
            const request =
              actionMenu.type === "problem"
                ? runJudge(
                    displayedContestants.filter(
                      (name) => selectedContestants[name],
                    ),
                    [actionMenu.name],
                  )
                : runJudge(
                    [actionMenu.name],
                    displayedProblems.filter((name) => selectedProblems[name]),
                  );
            setActionMenu(null);
            void request;
          }}
          onDetails={() => {
            setActiveLog({ type: actionMenu.type, name: actionMenu.name });
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
          onSave={saveProblemConfig}
          onClose={() => setActiveConfigProblem(null)}
          customCheckers={customCheckersMap[activeConfigProblem] || []}
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

      {openToolchains && (
        <ToolchainManager
          onClose={() => {
            setOpenToolchains(false);
            void handleFetchProblems();
          }}
        />
      )}

      {openToolchainSetup && (
        <ToolchainSetupModal
          isOpen={openToolchainSetup}
          onClose={() => {
            setOpenToolchainSetup(false);
            void handleFetchProblems();
          }}
        />
      )}
    </div>
  );
}
