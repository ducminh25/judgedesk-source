import { useEffect } from "react";
import { isMacOS, matchShortcut } from "./shortcuts.js";
import { isHelpShortcut, type HelpSectionId } from "../help/HelpCenter.js";
import { canExportScoreboard } from "../judging/availability.js";
import type { HostStatus } from "../../types.js";
import type { ScoreboardActionTarget } from "../scoreboard/Scoreboard.js";
import type { PendingContestAction } from "../contest/useContestFileActions.js";
import type { PendingScoreDeletion } from "../scores/useScoreDeletion.js";

export interface UseAppShortcutsOptions {
  hostStatus: HostStatus | null;
  updateHandoffActive: boolean;
  interactionLocked: boolean;
  canRun: boolean;
  contestantsList: string[];
  problemsList: string[];
  displayedContestants: string[];
  displayedProblems: string[];
  activeContestant: string | null;
  activeProblem: string | null;
  testsPickerPath: string;
  contestantsPickerPath: string;
  isContestDirty: boolean;
  hasContestData: boolean;

  // Modal states for Escape & modal-open checks
  actionMenu: ScoreboardActionTarget | null;
  activeDetails: unknown;
  activeConfigProblem: string | null;
  activeLog: unknown;
  loadModal: "tests" | "contestants" | null;
  helpSection: HelpSectionId | null;
  openToolchains: boolean;
  showOsdModal: boolean;
  pendingScoreDeletion: PendingScoreDeletion | null;
  pendingContestAction: PendingContestAction | null;

  // Close handlers
  onCloseActionMenu: () => void;
  onCloseActiveDetails: () => void;
  onCloseActiveLog: () => void;
  onCloseLoadModal: () => void;
  onCloseHelpSection: () => void;
  onCloseOpenToolchains: () => void;
  onCloseShowOsdModal: () => void;
  onClosePendingScoreDeletion: () => void;
  onClosePendingContestAction: () => void;

  // Action dispatches
  onOpenLoadModal: (kind: "tests" | "contestants", defaultPath: string) => void;
  onReloadFolders: () => void;
  onOpenToolchains: () => void;
  onToggleOsd: () => void;
  onRunJudge: () => void;
  onExportExcel: () => void;
  onRequestContestAction: (action: PendingContestAction) => void;
  onSaveContest: (forceSaveAs: boolean) => void;
  onOpenHelp: () => void;

  // Selection actions
  onSelectAllContestants: () => void;
  onDeselectAllContestants: () => void;
  onToggleActiveContestant: (target: string) => void;
  onSelectAllProblems: () => void;
  onDeselectAllProblems: () => void;
  onToggleActiveProblem: (target: string) => void;
}

export function useAppShortcuts({
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

  onCloseActionMenu,
  onCloseActiveDetails,
  onCloseActiveLog,
  onCloseLoadModal,
  onCloseHelpSection,
  onCloseOpenToolchains,
  onCloseShowOsdModal,
  onClosePendingScoreDeletion,
  onClosePendingContestAction,

  onOpenLoadModal,
  onReloadFolders,
  onOpenToolchains,
  onToggleOsd,
  onRunJudge,
  onExportExcel,
  onRequestContestAction,
  onSaveContest,
  onOpenHelp,

  onSelectAllContestants,
  onDeselectAllContestants,
  onToggleActiveContestant,
  onSelectAllProblems,
  onDeselectAllProblems,
  onToggleActiveProblem,
}: UseAppShortcutsOptions) {
  useEffect(() => {
    const isMac = isMacOS(hostStatus?.platform);

    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (updateHandoffActive) return;

      if (!isHelpShortcut(event)) {
        const action = matchShortcut(event, isMac);
        if (!action) return;

        // Escape closes any active modal or menu in order
        if (action === "escape") {
          // Configuration owns its nested popup/confirmation Escape priority.
          if (activeConfigProblem) return;
          if (actionMenu) {
            event.preventDefault();
            onCloseActionMenu();
            return;
          }
          if (activeDetails) {
            event.preventDefault();
            onCloseActiveDetails();
            return;
          }
          if (activeLog) {
            event.preventDefault();
            onCloseActiveLog();
            return;
          }
          if (loadModal) {
            event.preventDefault();
            onCloseLoadModal();
            return;
          }
          if (helpSection) {
            event.preventDefault();
            onCloseHelpSection();
            return;
          }
          if (openToolchains) {
            event.preventDefault();
            onCloseOpenToolchains();
            return;
          }
          if (showOsdModal) {
            event.preventDefault();
            onCloseShowOsdModal();
            return;
          }
          if (pendingScoreDeletion) {
            event.preventDefault();
            onClosePendingScoreDeletion();
            return;
          }
          if (pendingContestAction) {
            event.preventDefault();
            onClosePendingContestAction();
            return;
          }
          return;
        }

        const isAnyModalOpen =
          !!loadModal ||
          !!helpSection ||
          openToolchains ||
          showOsdModal ||
          !!pendingContestAction ||
          !!pendingScoreDeletion ||
          !!activeConfigProblem ||
          !!activeDetails ||
          !!activeLog ||
          !!actionMenu;

        event.preventDefault();
        event.stopPropagation();

        switch (action) {
          case "loadProblems":
            if (!interactionLocked && !isAnyModalOpen) {
              onOpenLoadModal("tests", testsPickerPath);
            }
            break;
          case "loadContestants":
            if (!interactionLocked && !isAnyModalOpen) {
              onOpenLoadModal("contestants", contestantsPickerPath);
            }
            break;
          case "reload":
            if (!interactionLocked && !isAnyModalOpen) {
              onReloadFolders();
            }
            break;
          case "toolchains":
            if (!interactionLocked && !isAnyModalOpen) {
              onOpenToolchains();
            }
            break;
          case "toggleOsd":
            if (!interactionLocked) {
              onToggleOsd();
            }
            break;
          case "judge":
            if (!interactionLocked && !isAnyModalOpen && canRun) {
              onRunJudge();
            }
            break;
          case "exportExcel":
            if (!interactionLocked && !isAnyModalOpen && canExportScoreboard(contestantsList, problemsList)) {
              onExportExcel();
            }
            break;
          case "newContest":
            if (!interactionLocked && !isAnyModalOpen) {
              onRequestContestAction("new");
            }
            break;
          case "openContest":
            if (!interactionLocked && !isAnyModalOpen) {
              onRequestContestAction("open");
            }
            break;
          case "saveContest":
            if (!interactionLocked && !isAnyModalOpen && isContestDirty && hasContestData) {
              onSaveContest(false);
            }
            break;
          case "saveContestAs":
            if (!interactionLocked && !isAnyModalOpen && isContestDirty && hasContestData) {
              onSaveContest(true);
            }
            break;
          case "selectAllContestants":
            if (!isAnyModalOpen) {
              onSelectAllContestants();
            }
            break;
          case "deselectAllContestants":
            if (!isAnyModalOpen) {
              onDeselectAllContestants();
            }
            break;
          case "toggleActiveContestant":
            if (!isAnyModalOpen) {
              const target = activeContestant || displayedContestants[0];
              if (target) {
                onToggleActiveContestant(target);
              }
            }
            break;
          case "selectAllProblems":
            if (!isAnyModalOpen) {
              onSelectAllProblems();
            }
            break;
          case "deselectAllProblems":
            if (!isAnyModalOpen) {
              onDeselectAllProblems();
            }
            break;
          case "toggleActiveProblem":
            if (!isAnyModalOpen) {
              const target = activeProblem || displayedProblems[0];
              if (target) {
                onToggleActiveProblem(target);
              }
            }
            break;
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onOpenHelp();
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [
    actionMenu,
    activeConfigProblem,
    activeContestant,
    activeDetails,
    activeLog,
    activeProblem,
    canRun,
    contestantsList,
    contestantsPickerPath,
    displayedContestants,
    displayedProblems,
    hasContestData,
    helpSection,
    hostStatus?.platform,
    interactionLocked,
    isContestDirty,
    loadModal,
    onCloseActionMenu,
    onCloseActiveDetails,
    onCloseActiveLog,
    onCloseHelpSection,
    onCloseLoadModal,
    onCloseOpenToolchains,
    onClosePendingContestAction,
    onClosePendingScoreDeletion,
    onCloseShowOsdModal,
    onDeselectAllContestants,
    onDeselectAllProblems,
    onExportExcel,
    onOpenHelp,
    onOpenLoadModal,
    onOpenToolchains,
    onReloadFolders,
    onRequestContestAction,
    onRunJudge,
    onSaveContest,
    onSelectAllContestants,
    onSelectAllProblems,
    onToggleActiveContestant,
    onToggleActiveProblem,
    onToggleOsd,
    openToolchains,
    pendingContestAction,
    pendingScoreDeletion,
    problemsList,
    showOsdModal,
    testsPickerPath,
    updateHandoffActive,
  ]);
}
