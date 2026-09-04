import React from "react";
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import DirectoryPickerModal from "./DirectoryPickerModal.js";
import EntityActionMenu from "./EntityActionMenu.js";
import ProgressWindow from "./ProgressWindow.js";
import ProblemConfigModal from "./ProblemConfigModal.js";
import JudgingDetailsModal from "./JudgingDetailsModal.js";
import ScoringLogModal from "./ScoringLogModal.js";
import HelpCenter, { type HelpSectionId } from "../features/help/HelpCenter.js";
import ToolchainManager from "../features/toolchains/ToolchainManager.js";
import type { ToolchainState } from "../features/toolchains/useToolchains.js";
import OsdSettingsModal from "../features/osd/OsdSettingsModal.js";
import type { OsdStatusState } from "../features/osd/useOsdSession.js";
import UnsavedContestDialog from "./UnsavedContestDialog.js";
import ScoreDeleteConfirmDialog from "./ScoreDeleteConfirmDialog.js";
import ContestSaveProgressDialog from "./ContestSaveProgressDialog.js";
import {
  DonationConfirmDialog,
  UpdateEditionChangeDialog,
  UpdateEditionDialog,
} from "../features/updates/UpdateDialogs.js";
import InstallUpdateDialog from "./InstallUpdateDialog.js";
import ChangelogModal from "../features/changelog/ChangelogModal.js";
import ThemisToolchainPromptModal, {
  type DetectedThemisToolchain,
  type ManagedToolchainInfo,
} from "../features/toolchains/ThemisToolchainPromptModal.js";
import ScratchToolchainPromptModal from "../features/toolchains/ScratchToolchainPromptModal.js";
import AppErrorToast from "./AppErrorToast.js";
import {
  requiresEditionChange,
  type UpdateEdition,
} from "../features/updates/catalog.js";
import { createDefaultProblemConfig } from "../../shared/problem-config.js";
import { problemHasPositiveScore } from "../features/judging/judge-results.js";
import type { HostStatus, BatchJudgeResult, ProblemConfig, ProblemResult } from "../types.js";
import type { ScoreboardActionTarget } from "../features/scoreboard/Scoreboard.js";
import type { AppError } from "../features/errors/app-error.js";
import type { useAppUpdater } from "../features/updates/useAppUpdater.js";
import type { PendingContestAction } from "../features/contest/useContestFileActions.js";
import type { PendingScoreDeletion } from "../features/scores/useScoreDeletion.js";

const DONATION_QR_URL = "https://img.vietqr.io/image/MB-0835385259-compact.png?amount=&addInfo=JudgeDesk%20Donation";

export interface AppModalsProps {
  // Modal visibility & states
  loadModal: "tests" | "contestants" | null;
  modalPath: string;
  actionMenu: ScoreboardActionTarget | null;
  progressState: { contestant: string; problem: string; action: string; percent: number } | null;
  activeConfigProblem: string | null;
  activeDetails: { cont: string; data: ProblemResult } | null;
  activeLog: { type: "problem" | "contestant"; name: string } | null;
  helpSection: HelpSectionId | null;
  openToolchains: boolean;
  showOsdModal: boolean;
  pendingContestAction: PendingContestAction | null;
  pendingScoreDeletion: PendingScoreDeletion | null;
  pendingScoreDeletionDescription: string;
  isSavingContest: boolean;
  showUpdateChoices: boolean;
  pendingUpdateEdition: UpdateEdition | null;
  showDonationConfirm: boolean;
  showInstallUpdate: boolean;
  showChangelog: boolean;
  showThemisPromptModal?: boolean;
  themisDetectedToolchains?: DetectedThemisToolchain[];
  managedToolchainsInfo?: ManagedToolchainInfo[];
  showScratchPromptModal?: boolean;
  isWindowDragging: boolean;
  appError: AppError | null;

  // Data & context
  hostStatus: HostStatus | null;
  judgeResult: BatchJudgeResult | null;
  testPath: string;
  thisinhPath: string;
  problemConfigs: Record<string, ProblemConfig>;
  customCheckersMap: Record<string, string[]>;
  interactorsMap?: Record<string, string[]>;
  interactionLocked: boolean;
  updater: ReturnType<typeof useAppUpdater>;
  osdStatus: OsdStatusState;
  updateRequiresRestart: boolean;
  updateRestartError: string;
  isInstallingUpdate: boolean;
  isJudging: boolean;

  // Callbacks & handlers
  onSetModalPath: (path: string) => void;
  onCloseLoadModal: () => void;
  onDropPath: (path: string) => Promise<void>;
  onLoadPath: () => Promise<void>;
  onCloseActionMenu: () => void;
  onOpenConfigProblem: (problemName: string) => void;
  onSetPendingScoreDeletion: (req: PendingScoreDeletion | null) => void;
  onRunJudgeTargets: (contestants?: string[], problems?: string[]) => Promise<void>;
  onOpenResultDetails: (contestantName: string, data: ProblemResult) => void;
  onOpenLog: (log: { type: "problem" | "contestant"; name: string }) => void;
  findProblemResult: (contestantName: string, problemName: string) => ProblemResult | undefined;
  displayedContestants: string[];
  displayedProblems: string[];
  selectedContestants: Record<string, boolean>;
  selectedProblems: Record<string, boolean>;
  onTerminateJudging: () => Promise<void>;
  onSaveProblemConfig: (name: string, config: ProblemConfig) => void;
  onDeleteProblemResults: (problemName: string) => void;
  onCloseConfigProblem: () => void;
  onCloseDetails: () => void;
  onCloseLog: () => void;
  loadHelpToolchains: () => Promise<ToolchainState>;
  onCloseHelp: () => void;
  onOpenToolchainsFromHelp: () => void;
  onOpenChangelogFromHelp: () => void;
  onCloseToolchains: () => void;
  onStartOsd: (options: { osdPath: string; enableLog?: boolean }) => Promise<{ success: boolean; message?: string }>;
  onStopOsd: () => Promise<void>;
  onCloseOsd: () => void;
  onCancelPendingContestAction: () => void;
  onContinuePendingContestAction: (saveFirst: boolean) => Promise<void>;
  onCancelScoreDeletion: () => void;
  onConfirmScoreDeletion: () => void;
  onCloseUpdateChoices: () => void;
  onChooseUpdateEdition: (edition: UpdateEdition) => void;
  onCancelUpdateEditionChange: () => void;
  onConfirmUpdateEditionChange: () => void;
  onCloseDonationConfirm: () => void;
  onSetErrorMessage: (msg: string) => void;
  onCloseInstallUpdate: () => void;
  onRestartUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onCloseChangelog: () => void;
  onCloseThemisPrompt?: () => void;
  onApplyThemisAll?: () => Promise<void>;
  onApplyManagedAll?: () => Promise<void>;
  onThemisSuccessToast?: (msg: string) => void;
  onCloseScratchPrompt?: () => void;
  onEnableScratch?: () => Promise<void>;
  onClearError: () => void;
}

export default function AppModals({
  loadModal,
  modalPath,
  actionMenu,
  progressState,
  activeConfigProblem,
  activeDetails,
  activeLog,
  helpSection,
  openToolchains,
  showOsdModal,
  pendingContestAction,
  pendingScoreDeletion,
  pendingScoreDeletionDescription,
  isSavingContest,
  showUpdateChoices,
  pendingUpdateEdition,
  showDonationConfirm,
  showInstallUpdate,
  showChangelog,
  showThemisPromptModal,
  themisDetectedToolchains,
  managedToolchainsInfo,
  showScratchPromptModal,
  isWindowDragging,
  appError,

  hostStatus,
  judgeResult,
  testPath,
  thisinhPath,
  problemConfigs,
  customCheckersMap,
  interactorsMap = {},
  interactionLocked,
  updater,
  osdStatus,
  updateRequiresRestart,
  updateRestartError,
  isInstallingUpdate,
  isJudging,

  onSetModalPath,
  onCloseLoadModal,
  onDropPath,
  onLoadPath,
  onCloseActionMenu,
  onOpenConfigProblem,
  onSetPendingScoreDeletion,
  onRunJudgeTargets,
  onOpenResultDetails,
  onOpenLog,
  findProblemResult,
  displayedContestants,
  displayedProblems,
  selectedContestants,
  selectedProblems,
  onTerminateJudging,
  onSaveProblemConfig,
  onDeleteProblemResults,
  onCloseConfigProblem,
  onCloseDetails,
  onCloseLog,
  loadHelpToolchains,
  onCloseHelp,
  onOpenToolchainsFromHelp,
  onOpenChangelogFromHelp,
  onCloseToolchains,
  onStartOsd,
  onStopOsd,
  onCloseOsd,
  onCancelPendingContestAction,
  onContinuePendingContestAction,
  onCancelScoreDeletion,
  onConfirmScoreDeletion,
  onCloseUpdateChoices,
  onChooseUpdateEdition,
  onCancelUpdateEditionChange,
  onConfirmUpdateEditionChange,
  onCloseDonationConfirm,
  onSetErrorMessage,
  onCloseInstallUpdate,
  onRestartUpdate,
  onInstallUpdate,
  onCloseChangelog,
  onCloseThemisPrompt,
  onApplyThemisAll,
  onApplyManagedAll,
  onThemisSuccessToast,
  onCloseScratchPrompt,
  onEnableScratch,
  onClearError,
}: AppModalsProps) {
  const { t } = useTranslation();

  return (
    <>
      {loadModal && (
        <DirectoryPickerModal
          kind={loadModal}
          path={modalPath}
          onPathChange={onSetModalPath}
          onClose={onCloseLoadModal}
          onDropPath={onDropPath}
          onLoad={onLoadPath}
        />
      )}

      {actionMenu && (
        <EntityActionMenu
          target={actionMenu}
          mutationsLocked={interactionLocked}
          onClose={onCloseActionMenu}
          onConfig={() => {
            if (actionMenu.problemName) onOpenConfigProblem(actionMenu.problemName);
            onCloseActionMenu();
          }}
          onDelete={() => {
            if (actionMenu.type === "result" && actionMenu.contestantName && actionMenu.problemName) {
              onSetPendingScoreDeletion({
                type: "result",
                contestantName: actionMenu.contestantName,
                problemName: actionMenu.problemName,
              });
            } else if (actionMenu.type === "problem" && actionMenu.problemName) {
              onSetPendingScoreDeletion({ type: "problem", problemName: actionMenu.problemName });
            } else if (actionMenu.contestantName) {
              onSetPendingScoreDeletion({ type: "contestant", contestantName: actionMenu.contestantName });
            }
            onCloseActionMenu();
          }}
          onRegrade={() => {
            let request: Promise<void> | undefined;
            if (actionMenu.type === "result" && actionMenu.contestantName && actionMenu.problemName) {
              request = onRunJudgeTargets([actionMenu.contestantName], [actionMenu.problemName]);
            } else if (actionMenu.type === "problem" && actionMenu.problemName) {
              request = onRunJudgeTargets(
                displayedContestants.filter((name) => selectedContestants[name]),
                [actionMenu.problemName],
              );
            } else if (actionMenu.contestantName) {
              request = onRunJudgeTargets(
                [actionMenu.contestantName],
                displayedProblems.filter((name) => selectedProblems[name]),
              );
            }
            onCloseActionMenu();
            if (request) void request;
          }}
          onDetails={() => {
            if (actionMenu.type === "result" && actionMenu.contestantName && actionMenu.problemName) {
              const problem = findProblemResult(actionMenu.contestantName, actionMenu.problemName);
              if (problem) onOpenResultDetails(actionMenu.contestantName, problem);
            } else if (actionMenu.type === "problem" && actionMenu.problemName) {
              onOpenLog({ type: "problem", name: actionMenu.problemName });
            } else if (actionMenu.contestantName) {
              onOpenLog({ type: "contestant", name: actionMenu.contestantName });
            }
            onCloseActionMenu();
          }}
        />
      )}

      {progressState && (
        <ProgressWindow
          currentContestant={progressState.contestant}
          currentProblem={progressState.problem}
          action={progressState.action}
          percent={progressState.percent}
          onTerminate={onTerminateJudging}
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
            onSaveProblemConfig(problemName, config);
            onDeleteProblemResults(problemName);
          }}
          onClose={onCloseConfigProblem}
          customCheckers={customCheckersMap[activeConfigProblem] || []}
          interactors={interactorsMap[activeConfigProblem] || []}
          saveDisabled={interactionLocked}
        />
      )}

      {activeDetails && (
        <JudgingDetailsModal
          contestantName={activeDetails.cont}
          data={activeDetails.data}
          onClose={onCloseDetails}
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
          onClose={onCloseLog}
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
          onClose={onCloseHelp}
          onOpenToolchains={onOpenToolchainsFromHelp}
          onOpenChangelog={onOpenChangelogFromHelp}
        />
      )}

      {openToolchains && (
        <ToolchainManager
          onClose={onCloseToolchains}
        />
      )}

      {showThemisPromptModal && (
        <ThemisToolchainPromptModal
          isOpen={showThemisPromptModal}
          onClose={onCloseThemisPrompt ?? (() => {})}
          themisToolchains={themisDetectedToolchains ?? []}
          managedToolchains={managedToolchainsInfo ?? []}
          onApplyManaged={onApplyManagedAll ?? (() => Promise.resolve())}
          onApplyThemis={onApplyThemisAll ?? (() => Promise.resolve())}
          onSuccessToast={onThemisSuccessToast}
        />
      )}

      {showScratchPromptModal && (
        <ScratchToolchainPromptModal
          isOpen={showScratchPromptModal}
          onClose={onCloseScratchPrompt ?? (() => {})}
          onEnableScratch={onEnableScratch ?? (() => Promise.resolve())}
          onSuccessToast={onThemisSuccessToast ?? (() => {})}
        />
      )}

      {showOsdModal && (
        <OsdSettingsModal
          status={osdStatus}
          contestantsPath={thisinhPath}
          testPath={testPath}
          onStart={onStartOsd}
          onStop={onStopOsd}
          onClose={onCloseOsd}
        />
      )}

      {pendingContestAction && (
        <UnsavedContestDialog
          isSaving={isSavingContest}
          onCancel={onCancelPendingContestAction}
          onDiscard={() => {
            void onContinuePendingContestAction(false);
          }}
          onSave={() => {
            void onContinuePendingContestAction(true);
          }}
        />
      )}

      {pendingScoreDeletion && (
        <ScoreDeleteConfirmDialog
          description={pendingScoreDeletionDescription}
          disabled={interactionLocked}
          onCancel={onCancelScoreDeletion}
          onConfirm={onConfirmScoreDeletion}
        />
      )}

      {isSavingContest && <ContestSaveProgressDialog />}

      {showUpdateChoices && updater.state.status === "available" && (
        <UpdateEditionDialog
          version={updater.state.version}
          currentEdition={updater.state.currentEdition}
          candidates={updater.state.candidates}
          onCancel={onCloseUpdateChoices}
          onChoose={(edition) => {
            if (!requiresEditionChange(updater.state.currentEdition, edition)) {
              onCloseUpdateChoices();
              void updater.downloadUpdate(edition);
              return;
            }
            onChooseUpdateEdition(edition);
          }}
        />
      )}

      {pendingUpdateEdition && updater.state.status === "available" && (
        <UpdateEditionChangeDialog
          currentEdition={updater.state.currentEdition}
          candidate={updater.state.candidates[pendingUpdateEdition]}
          onCancel={onCancelUpdateEditionChange}
          onConfirm={onConfirmUpdateEditionChange}
        />
      )}

      {showDonationConfirm && (
        <DonationConfirmDialog
          onCancel={onCloseDonationConfirm}
          onConfirm={() => {
            onCloseDonationConfirm();
            void (async () => {
              try {
                if ("__TAURI_INTERNALS__" in window) {
                  const { openUrl } = await import("@tauri-apps/plugin-opener");
                  await openUrl(DONATION_QR_URL);
                } else {
                  window.open(DONATION_QR_URL, "_blank", "noopener,noreferrer");
                }
              } catch (error) {
                onSetErrorMessage(error instanceof Error ? error.message : String(error));
              }
            })();
          }}
        />
      )}

      <InstallUpdateDialog
        show={showInstallUpdate}
        updateRequiresRestart={updateRequiresRestart}
        updateRestartError={updateRestartError}
        isInstallingUpdate={isInstallingUpdate}
        hostStatus={hostStatus}
        onClose={onCloseInstallUpdate}
        onRestart={onRestartUpdate}
        onInstall={onInstallUpdate}
      />

      {showChangelog && (
        <ChangelogModal onClose={onCloseChangelog} />
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

      <AppErrorToast error={appError} onClose={onClearError} />
    </>
  );
}
