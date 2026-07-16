import { useState } from "react";
import {
  CheckCircle2,
  Download,
  Github,
  Moon,
  Play,
  RefreshCw,
  Sun,
  Timer,
  Wrench,
  XCircle,
} from "lucide-react";
import type { HostStatus } from "../types";
import { useTranslation } from "react-i18next";
import { useTheme } from "../contexts/ThemeContext";
import { APP_VERSION } from "../version";
import type { AppUpdateState } from "../features/updates/useAppUpdater";

const PUBLIC_REPOSITORY = "https://github.com/ducminh25/themis-v2";

interface Props {
  errorMessage: string;
  hostStatus: HostStatus | null;
  isJudging: boolean;
  timeLimit: number;
  onOpenContestants: () => void;
  onOpenTests: () => void;
  onReload: () => void;
  onRun: () => void;
  onTimeLimitChange: (timeLimit: number) => void;
  onOpenToolchains: () => void;
  updateState: AppUpdateState;
  onCheckUpdates: () => void;
  onDownloadUpdate: () => void;
  onRequestInstall: () => void;
}

export default function AppToolbar({
  errorMessage,
  hostStatus,
  isJudging,
  timeLimit,
  onOpenContestants,
  onOpenTests,
  onReload,
  onRun,
  onTimeLimitChange,
  onOpenToolchains,
  updateState,
  onCheckUpdates,
  onDownloadUpdate,
  onRequestInstall,
}: Props) {
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();

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
    <>
      <header className="relative h-14 border-b border-surface-border flex items-center justify-between px-6 bg-surface shadow-md flex-shrink-0">
        <div className="flex items-center space-x-4">
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center font-bold italic text-white shadow-md shadow-indigo-950/20">LJ</div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-semibold tracking-tight text-text-primary">{t("toolbar.title")}</h1>
            <span className="text-[10px] text-text-muted font-medium">v{APP_VERSION}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <UpdateButton
            state={updateState}
            onCheck={onCheckUpdates}
            onDownload={onDownloadUpdate}
            onInstall={onRequestInstall}
          />
          <button
            onClick={() => void openRepository()}
            className="flex h-8 w-8 items-center justify-center rounded border border-surface-border bg-input-bg text-text-primary hover:bg-surface-hover transition-colors"
            title={t("toolbar.openGitHub")}
            aria-label={t("toolbar.openGitHub")}
          >
            <Github className="h-4 w-4" />
          </button>
          <button onClick={toggleTheme} className="flex h-8 w-8 items-center justify-center rounded border border-surface-border bg-input-bg text-text-primary hover:bg-surface-hover transition-colors" title={t("toolbar.toggleTheme")}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          
          <div className="flex items-center rounded border border-surface-border bg-input-bg overflow-hidden h-8" title={t("toolbar.toggleLanguage")}>
            <button onClick={() => i18n.changeLanguage('en')} className={`px-2 h-full text-xs font-bold transition-colors cursor-pointer ${i18n.language === 'en' ? 'bg-indigo-600 text-white' : 'text-text-muted hover:bg-surface-hover'}`}>EN</button>
            <button onClick={() => i18n.changeLanguage('vi')} className={`px-2 h-full text-xs font-bold transition-colors cursor-pointer ${i18n.language === 'vi' ? 'bg-indigo-600 text-white' : 'text-text-muted hover:bg-surface-hover'}`}>VI</button>
          </div>

          <div className="relative">
            <button onClick={() => setStatusMenuOpen((open) => !open)} className="flex h-8 items-center gap-2 rounded border border-surface-border bg-input-bg px-3 text-xs font-semibold text-text-primary hover:bg-surface-hover transition-colors" title={t("toolbar.settings")}>
              <Wrench className="h-3.5 w-3.5" /> {t("toolbar.settings")}
            </button>
            {statusMenuOpen && <HostStatusMenu status={hostStatus} onOpenToolchains={onOpenToolchains} />}
          </div>
        </div>
      </header>

      <div className="h-14 bg-surface border-b border-surface-border flex items-center justify-between px-6 flex-shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={onOpenTests} className="flex items-center gap-2 px-3 py-1.5 bg-surface-elevated hover:bg-surface-hover text-text-primary text-xs font-semibold rounded border border-surface-border transition cursor-pointer shadow-sm" title={t("directoryPicker.selectTests")}>
            <TestcasesIcon /> <span>{t("toolbar.loadTests")}</span>
          </button>
          <button onClick={onOpenContestants} className="flex items-center gap-2 px-3 py-1.5 bg-surface-elevated hover:bg-surface-hover text-text-primary text-xs font-semibold rounded border border-surface-border transition cursor-pointer shadow-sm" title={t("directoryPicker.selectContestants")}>
            <ContestantsIcon /> <span>{t("toolbar.loadContestants")}</span>
          </button>
          <div className="flex items-center gap-2 bg-input-bg border border-surface-border rounded px-2.5 py-1">
            <Timer className="w-3.5 h-3.5 text-text-muted" />
            <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t("toolbar.timeLimit")}:</span>
            <input type="number" value={timeLimit} onChange={(event) => onTimeLimitChange(Number(event.target.value))} className="bg-transparent text-xs text-text-primary font-bold focus:outline-none w-16 font-mono" />
            <span className="text-[10px] text-text-muted font-medium">ms</span>
          </div>
          <button onClick={onReload} className="p-2 bg-surface-elevated hover:bg-surface-hover text-text-primary rounded border border-surface-border transition cursor-pointer" title={t("toolbar.refresh")}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-3">
          {errorMessage && <div className="text-[10px] font-medium bg-rose-100 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-300 dark:border-rose-900/50 rounded px-3 py-1 max-w-xs truncate">{errorMessage}</div>}
          <button onClick={onRun} disabled={isJudging} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold px-4 py-1.5 rounded text-xs transition-all shadow-md shadow-indigo-950/20 flex items-center gap-2 cursor-pointer">
            {isJudging ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /><span>{t("status.judging")}...</span></> : <><Play className="w-3.5 h-3.5" /><span>{t("toolbar.run")}</span></>}
          </button>
        </div>
      </div>
    </>
  );
}

function UpdateButton({
  state,
  onCheck,
  onDownload,
  onInstall,
}: {
  state: AppUpdateState;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const isBusy = state.status === "checking" || state.status === "downloading";
  const onClick =
    state.status === "available"
      ? onDownload
      : state.status === "downloaded"
        ? onInstall
        : onCheck;
  const label = (() => {
    switch (state.status) {
      case "checking":
        return t("updates.checking");
      case "available":
        return t("updates.download");
      case "downloading":
        return t("updates.downloading", { percent: state.percent });
      case "downloaded":
        return t("updates.installQuestion");
      case "current":
        return t("updates.upToDate");
      case "error":
        return state.phase === "download"
          ? t("updates.downloadFailed")
          : state.phase === "install"
            ? t("updates.installFailed")
            : t("updates.checkFailed");
      default:
        return t("updates.check");
    }
  })();
  const title = state.status === "available"
    ? t("updates.available", { version: state.version })
    : state.status === "error"
      ? state.message
      : label;

  return (
    <button
      onClick={onClick}
      disabled={isBusy}
      className={`flex h-8 items-center gap-2 rounded border px-3 text-xs font-semibold transition-colors disabled:cursor-wait ${
        state.status === "available" || state.status === "downloaded"
          ? "border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-500"
          : state.status === "error"
            ? "border-rose-400 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-950 dark:text-rose-300"
            : "border-surface-border bg-input-bg text-text-primary hover:bg-surface-hover"
      }`}
      title={title}
    >
      {state.status === "downloading" || state.status === "checking" ? (
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      <span>{label}</span>
    </button>
  );
}

function HostStatusMenu({ status, onOpenToolchains }: { status: HostStatus | null; onOpenToolchains: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="absolute right-0 top-10 z-[80] w-72 rounded-md border border-surface-border bg-surface-elevated p-2 shadow-2xl">
      <div className="px-2 py-1.5 text-[10px] font-bold uppercase text-text-muted">{t("toolbar.statusMenu.title")}</div>
      {status ? (
        <>
          <StatusRow label="WSL2" ready={!!status.sandbox?.wsl.ready} installed={!!status.sandbox?.wsl.installed} incompleteLabel={t("toolbar.statusMenu.incomplete")} />
          <StatusRow label="Docker" ready={!!status.sandbox?.docker.ready} installed={!!status.sandbox?.docker.installed} incompleteLabel={t("toolbar.statusMenu.unavailable")} />
          {!status.sandbox?.ready && (
            <>
              <div className="my-1 border-t border-surface-border" />
              <ToolRow label="G++" installed={status.gpp.installed} />
              <ToolRow label="Python" installed={status.python.installed} />
            </>
          )}
          <div className="mt-1 border-t border-surface-border px-2 pt-2 text-[10px] text-text-muted">
            {t("toolbar.statusMenu.activeRunner")}: <span className="font-mono text-text-primary">{status.sandbox?.mode ?? "none"}</span>
          </div>
          <div className="mt-2 pt-2 border-t border-surface-border">
            <button 
              onClick={onOpenToolchains} 
              className="w-full text-center py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[10px] font-bold uppercase tracking-wider transition cursor-pointer"
            >
              {t("toolchains.managerTitle")}
            </button>
          </div>
        </>
      ) : <div className="px-2 py-4 text-xs text-text-muted">{t("toolbar.statusMenu.checking")}</div>}
    </div>
  );
}

function StatusRow({ label, ready, installed, incompleteLabel }: { label: string; ready: boolean; installed: boolean; incompleteLabel: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between px-2 py-2 text-xs">
      <span className="text-text-primary">{label}</span>
      <span className={`flex items-center gap-1.5 ${ready ? "text-emerald-500 dark:text-emerald-400" : installed ? "text-amber-500 dark:text-amber-400" : "text-rose-500 dark:text-rose-400"}`}>
        {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {ready ? t("toolbar.statusMenu.ready") : installed ? incompleteLabel : t("toolbar.statusMenu.notInstalled")}
      </span>
    </div>
  );
}

function ToolRow({ label, installed }: { label: string; installed: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between px-2 py-2 text-xs">
      <span className="text-text-primary">{label}</span>
      <span className={`flex items-center gap-1.5 ${installed ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400"}`}>
        {installed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {installed ? t("toolbar.statusMenu.inPath") : t("toolbar.statusMenu.notInPath")}
      </span>
    </div>
  );
}

const TestcasesIcon = () => (
  <svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
    <path d="M4 10C4 8.89543 4.89543 8 6 8H18L24 14H42C43.1046 14 44 14.8954 44 16V40C44 41.1046 43.1046 42 42 42H6C4.89543 42 4 41.1046 4 40V10Z" fill="#F59E0B" stroke="#D97706" strokeWidth="2" />
    <path d="M28 20L34 26M34 26L28 32M34 26H18C15 26 14 28 14 32" stroke="#10B981" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ContestantsIcon = () => (
  <svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
    <circle cx="16" cy="18" r="6" fill="#10B981" />
    <path d="M8 36C8 30 12 28 16 28C20 28 24 30 24 36" fill="#10B981" />
    <circle cx="24" cy="14" r="6" fill="#FBBF24" />
    <path d="M16 32C16 26 20 24 24 24C28 24 32 26 32 32" fill="#FBBF24" />
    <circle cx="32" cy="22" r="6" fill="#3B82F6" />
    <path d="M24 40C24 34 28 32 32 32C36 32 40 34 40 40" fill="#3B82F6" />
  </svg>
);
