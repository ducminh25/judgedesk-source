import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleHelp,
  ClipboardList,
  Download,
  FilePlus2,
  FileSpreadsheet,
  FolderOpen,
  Github,
  Languages,
  Moon,
  Play,
  RefreshCw,
  Save,
  Settings2,
  Sun,
  Trash2,
  UsersRound,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import type { HostStatus } from "../types";
import { useTranslation } from "react-i18next";
import { useTheme } from "../contexts/ThemeContext";
import { APP_VERSION } from "../version";
import type { AppUpdateState } from "../features/updates/useAppUpdater";

const PUBLIC_REPOSITORY = "https://github.com/ducminh25/judgedesk";

interface Props {
  canDeleteSelected: boolean;
  canExport: boolean;
  canRun: boolean;
  canSaveContest: boolean;
  errorMessage: string;
  hostStatus: HostStatus | null;
  interactionLocked: boolean;
  isExporting: boolean;
  isJudging: boolean;
  isSavingContest: boolean;
  onDeleteSelected: () => void;
  onExport: () => void;
  onNewContest: () => void;
  onOpenContest: () => void;
  onOpenContestants: () => void;
  onOpenTests: () => void;
  onReload: () => void;
  onRun: () => void;
  onSaveContest: () => void;
  onOpenHelp: () => void;
  onOpenToolchains: () => void;
  onRequestHostStatus: () => void;
  updateState: AppUpdateState;
  onCheckUpdates: () => void;
  onDownloadUpdate: () => void;
  onRequestInstall: () => void;
}

const commandButton =
  "flex h-9 flex-none items-center gap-2 rounded border border-surface-border bg-surface-elevated px-3 text-xs font-semibold text-text-primary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40";
const iconCommandButton =
  "flex h-9 w-9 flex-none items-center justify-center rounded border border-surface-border bg-surface-elevated text-text-primary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40";

export default function AppToolbar({
  canDeleteSelected,
  canExport,
  canRun,
  canSaveContest,
  errorMessage,
  hostStatus,
  interactionLocked,
  isExporting,
  isJudging,
  isSavingContest,
  onDeleteSelected,
  onExport,
  onNewContest,
  onOpenContest,
  onOpenContestants,
  onOpenTests,
  onReload,
  onRun,
  onSaveContest,
  onOpenHelp,
  onOpenToolchains,
  onRequestHostStatus,
  updateState,
  onCheckUpdates,
  onDownloadUpdate,
  onRequestInstall,
}: Props) {
  const [utilityMenuOpen, setUtilityMenuOpen] = useState(false);
  const utilityMenuRef = useRef<HTMLDivElement>(null);
  const utilityMenuButtonRef = useRef<HTMLButtonElement>(null);
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  useEffect(() => {
    if (interactionLocked) setUtilityMenuOpen(false);
  }, [interactionLocked]);

  useEffect(() => {
    if (!utilityMenuOpen) return;
    const closeWhenOutside = (event: Event) => {
      if (!utilityMenuRef.current?.contains(event.target as Node)) {
        setUtilityMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setUtilityMenuOpen(false);
      utilityMenuButtonRef.current?.focus();
    };
    const closeOnWindowBlur = () => setUtilityMenuOpen(false);
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("focusin", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("focusin", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnWindowBlur);
    };
  }, [utilityMenuOpen]);

  const openRepository = async () => {
    try {
      if ("__TAURI_INTERNALS__" in window) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(PUBLIC_REPOSITORY);
      } else {
        window.open(PUBLIC_REPOSITORY, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      console.error("Could not open the public repository", error);
    }
  };

  return (
    <header className="command-bar-scroll flex h-14 flex-none items-center overflow-x-auto border-b border-surface-border bg-surface px-3">
      <div className="flex min-w-max flex-1 items-center gap-2">
        <div className="mr-2 flex h-9 flex-none items-center gap-2 border-r border-surface-border pr-4">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-indigo-600 text-[11px] font-bold text-white">
            JD
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-text-primary">JudgeDesk</div>
            <div className="text-[9px] text-text-muted">v{APP_VERSION}</div>
          </div>
        </div>

        <button type="button" onClick={onOpenTests} disabled={interactionLocked} className={iconCommandButton} title={t("toolbar.loadTests")} aria-label={t("toolbar.loadTests")}>
          <ClipboardList className="h-4 w-4 text-amber-500" />
        </button>
        <button type="button" onClick={onOpenContestants} disabled={interactionLocked} className={iconCommandButton} title={t("toolbar.loadContestants")} aria-label={t("toolbar.loadContestants")}>
          <UsersRound className="h-4 w-4 text-sky-500" />
        </button>
        <button type="button" onClick={onReload} disabled={interactionLocked} className={commandButton} title={t("toolbar.reloadHint")}>
          <RefreshCw className="h-4 w-4" />
          <span>{t("toolbar.refresh")}</span>
        </button>

        <div className="mx-1 h-7 w-px flex-none bg-surface-border" />
        <button type="button" onClick={onNewContest} disabled={interactionLocked} className={iconCommandButton} title={t("contest.new")} aria-label={t("contest.new")}>
          <FilePlus2 className="h-4 w-4 text-text-muted" />
        </button>
        <button type="button" onClick={onOpenContest} disabled={interactionLocked} className={iconCommandButton} title={t("contest.open")} aria-label={t("contest.open")}>
          <FolderOpen className="h-4 w-4 text-amber-500" />
        </button>
        <button type="button" onClick={onSaveContest} disabled={!canSaveContest || interactionLocked} className={iconCommandButton} title={t("contest.save")} aria-label={t("contest.save")}>
          {isSavingContest ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 text-sky-600 dark:text-sky-400" />}
        </button>

        <div className="mx-1 h-7 w-px flex-none bg-surface-border" />
        <button
          type="button"
          onClick={onRun}
          disabled={interactionLocked || !canRun}
          title={!canRun ? t("actions.missingData") : undefined}
          className="flex h-9 flex-none items-center gap-2 rounded bg-indigo-600 px-4 text-xs font-bold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isJudging ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          <span>{isJudging ? t("status.judging") : t("toolbar.run")}</span>
        </button>
        <button type="button" onClick={onExport} disabled={!canExport || interactionLocked || isExporting} className={commandButton}>
          {isExporting
            ? <RefreshCw className="h-4 w-4 animate-spin" />
            : <FileSpreadsheet className="h-4 w-4 text-emerald-500" />}
          <span>{isExporting ? t("export.exporting") : t("scoreboard.export")}</span>
        </button>
        <button
          type="button"
          onClick={onDeleteSelected}
          disabled={!canDeleteSelected || interactionLocked}
          className={iconCommandButton}
          title={t("actions.deleteSelectedScores")}
          aria-label={t("actions.deleteSelectedScores")}
        >
          <Trash2 className="h-4 w-4 text-rose-500" />
        </button>

        <div className="min-w-3 flex-1" />
        {errorMessage && (
          <div className="max-w-64 flex-none truncate rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-[10px] font-medium text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300" title={errorMessage}>
            {errorMessage}
          </div>
        )}
        <HelpButton onOpen={onOpenHelp} />
        <UpdateButton state={updateState} disabled={interactionLocked} onCheck={onCheckUpdates} onDownload={onDownloadUpdate} onInstall={onRequestInstall} />

        <div ref={utilityMenuRef} className="relative flex-none">
          <button
            ref={utilityMenuButtonRef}
            type="button"
            onClick={() => {
              setUtilityMenuOpen((open) => {
                if (!open) onRequestHostStatus();
                return !open;
              });
            }}
            disabled={interactionLocked}
            className="flex h-9 w-9 items-center justify-center rounded border border-surface-border bg-surface-elevated text-text-primary hover:bg-surface-hover"
            title={t("toolbar.settings")}
            aria-haspopup="menu"
            aria-expanded={utilityMenuOpen}
          >
            <Settings2 className="h-4 w-4" />
          </button>
          {utilityMenuOpen && (
            <HostStatusMenu
              status={hostStatus}
              theme={theme}
              language={i18n.language}
              onClose={() => setUtilityMenuOpen(false)}
              onOpenToolchains={() => {
                setUtilityMenuOpen(false);
                onOpenToolchains();
              }}
              onToggleTheme={toggleTheme}
              onChangeLanguage={(language) => void i18n.changeLanguage(language)}
              onOpenRepository={() => void openRepository()}
            />
          )}
        </div>
      </div>
    </header>
  );
}

export function HelpButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${t("helpCenter.open")} (F1)`}
      aria-label={`${t("helpCenter.open")} (F1)`}
      aria-keyshortcuts="F1"
      className="flex h-10 flex-none items-center justify-center gap-2 whitespace-nowrap rounded border border-surface-border bg-surface-elevated px-3 text-xs font-bold text-text-primary transition-colors hover:bg-surface-hover"
    >
      <CircleHelp className="h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-300" />
      <span>{t("helpCenter.open")}</span>
    </button>
  );
}

export function UpdateButton({ state, disabled, onCheck, onDownload, onInstall }: {
  state: AppUpdateState;
  disabled: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const isBusy = state.status === "checking" || state.status === "downloading";
  const onClick = state.status === "available" ? onDownload : state.status === "downloaded" ? onInstall : onCheck;
  const label = (() => {
    switch (state.status) {
      case "checking": return t("updates.checking");
      case "available": return t("updates.available", { version: state.version });
      case "downloading": return t("updates.downloading", { percent: state.percent });
      case "downloaded": return t("updates.installQuestion");
      case "current": return t("updates.upToDate");
      case "error":
        if (state.phase === "download") return t("updates.downloadFailed");
        if (state.phase === "check") return t("updates.checkFailed");
        return t("updates.installFailed");
      default: return t("updates.check");
    }
  })();
  const visibleLabel = state.status === "error" ? t("updates.retry") : label;
  const accessibleLabel = state.status === "error" ? `${label}. ${visibleLabel}` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isBusy}
      title={label}
      aria-label={accessibleLabel}
      className={`flex h-10 max-w-56 flex-none items-center justify-center gap-2 whitespace-nowrap rounded border px-3 text-xs font-bold transition-colors disabled:cursor-wait ${
        state.status === "available" || state.status === "downloaded"
          ? "border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-500"
          : state.status === "error"
            ? "border-rose-400 bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
            : "border-surface-border bg-surface-elevated text-text-primary hover:bg-surface-hover"
      }`}
    >
      {isBusy ? (
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
      ) : state.status === "current" ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
      ) : state.status === "error" ? (
        <XCircle className="h-4 w-4 shrink-0" />
      ) : (
        <Download className="h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0 truncate">{visibleLabel}</span>
    </button>
  );
}

export function HostStatusMenu({
  status,
  theme = "light",
  language = "en",
  onClose,
  onOpenToolchains,
  onToggleTheme = () => {},
  onChangeLanguage = () => {},
  onOpenRepository = () => {},
}: {
  status: HostStatus | null;
  theme?: "light" | "dark";
  language?: string;
  onClose: () => void;
  onOpenToolchains: () => void;
  onToggleTheme?: () => void;
  onChangeLanguage?: (language: "en" | "vi") => void;
  onOpenRepository?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="menu" className="fixed right-3 top-14 z-[80] w-72 overflow-hidden rounded-md border border-surface-border bg-surface-elevated p-2 shadow-2xl">
      <div className="flex items-center justify-between px-2 py-1.5">
        <div className="text-[10px] font-bold uppercase text-text-muted">{t("toolbar.statusMenu.title")}</div>
        <button type="button" onClick={onClose} className="rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary" aria-label={t("common.close")}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {status ? (
        <>
          <StatusRow label="Native protection" ready={status.secureRunner.ready} installed={status.secureRunner.mode !== "unavailable"} incompleteLabel={t("toolbar.statusMenu.unavailable")} />
          {!status.secureRunner.ready && status.secureRunner.diagnostics.length > 0 && (
            <div className="mx-2 my-1 rounded border border-rose-200 bg-rose-50 p-2 text-[9px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-300">
              {status.secureRunner.diagnostics.join("; ")}
            </div>
          )}
          {(
            <>
              <div className="my-1 border-t border-surface-border" />
              <ToolRow
                label="G++"
                detected={status.gpp.installed}
                submissionReady={status.gpp.submissionReady ?? status.gpp.installed}
                checkerReady={status.gpp.checkerReady ?? status.gpp.installed}
                diagnostic={status.gpp.diagnostic}
              />
              <ToolRow
                label="Python"
                detected={status.python.installed}
                submissionReady={status.python.submissionReady ?? status.python.installed}
                checkerReady={status.python.checkerReady ?? status.python.installed}
                diagnostic={status.python.diagnostic}
              />
            </>
          )}
          <div className="border-t border-surface-border px-2 pt-2 text-[10px] text-text-muted">
            {t("toolbar.statusMenu.activeRunner")}: <span className="font-mono text-text-primary">{status.secureRunner.mode}</span>
          </div>
          {status.build && (
            <div className="px-2 pt-1 text-[10px] text-text-muted">
              JudgeDesk <span className="font-mono text-text-primary">v{status.build.appVersion}</span>
              {" · "}
              <span className="font-mono text-text-primary">
                {status.build.gitCommit === "unknown" ? "unknown" : status.build.gitCommit.slice(0, 12)}
              </span>
              {" · build "}
              <span className="font-mono text-text-primary">{status.build.buildNumber}</span>
            </div>
          )}
        </>
      ) : <div className="px-2 py-3 text-xs text-text-muted">{t("toolbar.statusMenu.checking")}</div>}

      <div className="mt-2 grid grid-cols-2 gap-1 border-t border-surface-border pt-2">
        <button type="button" onClick={onToggleTheme} className="flex items-center gap-2 rounded px-2 py-2 text-xs text-text-primary hover:bg-surface-hover">
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          {t("toolbar.toggleTheme")}
        </button>
        <button type="button" onClick={() => onChangeLanguage?.(language?.startsWith("vi") ? "en" : "vi")} className="flex items-center gap-2 rounded px-2 py-2 text-xs text-text-primary hover:bg-surface-hover">
          <Languages className="h-3.5 w-3.5" /> {language.startsWith("vi") ? "English" : "Tiếng Việt"}
        </button>
        <button type="button" onClick={onOpenRepository} className="flex items-center gap-2 rounded px-2 py-2 text-xs text-text-primary hover:bg-surface-hover">
          <Github className="h-3.5 w-3.5" /> GitHub
        </button>
        <button type="button" onClick={onOpenToolchains} className="flex items-center gap-2 rounded px-2 py-2 text-xs text-text-primary hover:bg-surface-hover">
          <Wrench className="h-3.5 w-3.5" /> {t("toolchains.managerTitle")}
        </button>
      </div>
    </div>
  );
}

function StatusRow({ label, ready, installed, incompleteLabel }: { label: string; ready: boolean; installed: boolean; incompleteLabel: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between px-2 py-2 text-xs">
      <span className="text-text-primary">{label}</span>
      <span className={`flex items-center gap-1.5 ${ready ? "text-emerald-500" : installed ? "text-amber-500" : "text-rose-500"}`}>
        {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {ready ? t("toolbar.statusMenu.ready") : installed ? incompleteLabel : t("toolbar.statusMenu.notInstalled")}
      </span>
    </div>
  );
}

function ToolRow({
  label,
  detected,
  submissionReady,
  checkerReady,
  diagnostic,
}: {
  label: string;
  detected: boolean;
  submissionReady: boolean;
  checkerReady: boolean;
  diagnostic?: string;
}) {
  const { t } = useTranslation();
  const state = submissionReady
    ? "ready"
    : checkerReady
      ? "checker"
      : detected
        ? "managed"
        : "missing";
  const labelText = state === "ready"
    ? t("toolbar.statusMenu.submissionReady")
    : state === "checker"
      ? t("toolbar.statusMenu.checkerOnly")
      : state === "managed"
        ? t("toolbar.statusMenu.managedRequired")
        : t("toolbar.statusMenu.notInPath");
  return (
    <div className="flex items-center justify-between px-2 py-2 text-xs" title={diagnostic}>
      <span className="text-text-primary">{label}</span>
      <span className={`flex items-center gap-1.5 ${
        state === "ready" ? "text-emerald-500" : state === "missing" ? "text-rose-500" : "text-amber-500"
      }`}>
        {state === "ready" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {labelText}
      </span>
    </div>
  );
}
