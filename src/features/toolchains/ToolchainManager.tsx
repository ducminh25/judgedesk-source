import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type LanguageProfileView,
  type ToolchainSourceMode,
  useToolchains,
} from "./useToolchains.js";

interface Props {
  onClose: () => void;
  firstRun?: boolean;
}

const SOURCE_MODES: readonly ToolchainSourceMode[] = [
  "none",
  "managed",
  "local_path",
  "local_auto",
];

export default function ToolchainManager({ onClose, firstRun = false }: Props) {
  const { t } = useTranslation();
  const {
    state,
    error,
    install,
    cancel,
    uninstall,
    setProfilePreference,
    rescan,
  } = useToolchains();

  return (
    <div className={`fixed inset-0 ${firstRun ? "z-[90]" : "z-50"} flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm`}>
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-surface-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-lg bg-indigo-500/10 p-2">
              <Cpu className="h-5 w-5 text-indigo-500 dark:text-indigo-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold uppercase tracking-wider text-text-primary">
                {firstRun ? t("toolchains.setup.title") : t("toolchains.managerTitle")}
              </h2>
              <p className="mt-0.5 truncate text-2xs text-text-muted">
                {firstRun
                  ? t("toolchains.registry.firstRunHint")
                  : t("toolchains.registry.managerHint")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={
                !state
                || state.discovery.status === "running"
                || state.mutationsBlocked
              }
              onClick={() => void rescan()}
              className="flex items-center gap-1.5 rounded border border-surface-border bg-input-bg px-2.5 py-1.5 text-2xs font-bold text-text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${state?.discovery.status === "running" ? "animate-spin" : ""}`} />
              {t("toolchains.rescan")}
            </button>
            <button
              type="button"
              aria-label={t("toolchains.close")}
              onClick={onClose}
              className="text-text-muted transition-colors hover:text-text-primary"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {!state ? (
            <LoadingState error={error} />
          ) : (
            <div className="space-y-4">
              {state.preferenceDocument.status === "recovery" && (
                <Notice tone="danger">
                  {t("toolchains.registry.preferencesRecovery")}
                </Notice>
              )}
              {state.mutationsBlocked && (
                <Notice tone="warning">
                  {t("toolchains.registry.mutationsBlocked")}
                </Notice>
              )}
              {error && <Notice tone="danger">{error}</Notice>}
              {state.manifestError && (
                <Notice tone="warning">
                  {t("toolchains.manifestUnavailable")}: {state.manifestError}
                </Notice>
              )}
              <DiscoveryNotice status={state.discovery.status} />

              <ToolchainRegistryTable
                profiles={state.profiles}
                discoveryStatus={state.discovery.status}
                preferenceLocked={
                  state.preferenceDocument.status === "recovery"
                  || state.mutationsBlocked
                }
                onSetPreference={setProfilePreference}
                onInstall={install}
                onCancel={cancel}
                onUninstall={uninstall}
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-surface-border bg-surface-elevated p-4">
          <span className="text-2xs text-text-muted">
            {state
              ? t("toolchains.registry.registryRevision", { revision: state.registryRevision })
              : ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-indigo-600 px-5 py-2 text-xs font-bold uppercase tracking-wider text-white transition hover:bg-indigo-500"
          >
            {firstRun ? t("toolchains.setup.finish") : t("toolchains.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ToolchainRegistryTable({
  profiles,
  discoveryStatus,
  preferenceLocked,
  onSetPreference,
  onInstall,
  onCancel,
  onUninstall,
}: {
  profiles: LanguageProfileView[];
  discoveryStatus: "not_started" | "running" | "complete" | "failed";
  preferenceLocked: boolean;
  onSetPreference: (
    profileId: string,
    mode: ToolchainSourceMode,
    localPath?: string,
  ) => Promise<boolean>;
  onInstall: (id: string) => Promise<boolean>;
  onCancel: (id: string) => Promise<void>;
  onUninstall: (id: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-lg border border-surface-border">
      <table className="w-full min-w-[900px] border-collapse text-left">
        <thead className="bg-surface-elevated text-2xs uppercase tracking-wider text-text-muted">
          <tr>
            <th className="w-[16%] px-4 py-3">{t("toolchains.registry.language")}</th>
            <th className="w-[18%] px-4 py-3">{t("toolchains.status")}</th>
            <th className="w-[42%] px-4 py-3">{t("toolchains.registry.sourceSelection")}</th>
            <th className="w-[24%] px-4 py-3">{t("toolchains.registry.actions")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {profiles.map((profile) => (
            <ProfileRow
              key={`${profile.id}@${profile.version}`}
              profile={profile}
              discoveryStatus={discoveryStatus}
              preferenceLocked={preferenceLocked}
              onSetPreference={onSetPreference}
              onInstall={onInstall}
              onCancel={onCancel}
              onUninstall={onUninstall}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LoadingState({ error }: { error: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <Notice tone="info">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>
          <strong>{t("toolchains.loadingState")}</strong>{" "}
          {t("toolchains.loadingHint")}
        </span>
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

function DiscoveryNotice({
  status,
}: {
  status: "not_started" | "running" | "complete" | "failed";
}) {
  const { t } = useTranslation();
  if (status === "complete") return null;
  return (
    <Notice tone={status === "failed" ? "warning" : "info"}>
      {status === "running" && <Loader2 className="h-4 w-4 animate-spin" />}
      {t(`toolchains.registry.discovery.${status}`)}
    </Notice>
  );
}

function ProfileRow({
  profile,
  discoveryStatus,
  preferenceLocked,
  onSetPreference,
  onInstall,
  onCancel,
  onUninstall,
}: {
  key?: React.Key;
  profile: LanguageProfileView;
  discoveryStatus: "not_started" | "running" | "complete" | "failed";
  preferenceLocked: boolean;
  onSetPreference: (
    profileId: string,
    mode: ToolchainSourceMode,
    localPath?: string,
  ) => Promise<boolean>;
  onInstall: (id: string) => Promise<boolean>;
  onCancel: (id: string) => Promise<void>;
  onUninstall: (id: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [localPath, setLocalPath] = useState(profile.selection.localPath || "");
  const [pathDirty, setPathDirty] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!pathDirty) setLocalPath(profile.selection.localPath || "");
  }, [pathDirty, profile.selection.localPath]);

  const applyPreference = async (
    mode: ToolchainSourceMode,
    selectedPath?: string,
  ) => {
    setPending(true);
    const applied = await onSetPreference(profile.id, mode, selectedPath);
    setPending(false);
    if (applied && selectedPath !== undefined) setPathDirty(false);
  };

  const browse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        title: t("toolchains.registry.browseTitle", {
          language: t(profile.displayNameKey),
        }),
      });
      if (typeof selected === "string") {
        setLocalPath(selected);
        setPathDirty(true);
      }
    } catch {
      // The text field remains the portable fallback in a regular browser.
    }
  };

  const managed = profile.managedPackage;
  const installing = !!managed && ["downloading", "extracting", "verifying"].includes(
    managed.progress.status,
  );
  const controlsDisabled = preferenceLocked || pending;

  return (
    <tr className="align-top bg-surface">
      <td className="px-4 py-4">
        <div className="font-bold text-text-primary">{t(profile.displayNameKey)}</div>
        <div className="mt-1 font-mono text-2xs text-text-muted">
          {profile.extensions.join(", ")} · v{profile.version}
        </div>
        {profile.stability === "experimental" && (
          <span className="mt-2 inline-flex rounded bg-amber-500/10 px-1.5 py-0.5 text-2xs font-bold text-amber-600 dark:text-amber-400">
            {t("toolchains.registry.experimental")}
          </span>
        )}
      </td>
      <td className="px-4 py-4">
        <StatusBadge status={profile.status} />
        {profile.diagnostic && (
          <p className="mt-2 text-2xs leading-relaxed text-text-muted">
            {t(profile.diagnostic.messageKey, {
              defaultValue: profile.diagnostic.message || profile.diagnostic.code,
            })}
          </p>
        )}
        {(profile.active.executablePath || profile.active.version) && (
          <div className="mt-2 space-y-1 break-all font-mono text-[10px] text-text-muted">
            <div>{profile.active.executablePath || "-"}</div>
            <div>{profile.active.version || "-"}</div>
          </div>
        )}
      </td>
      <td className="px-4 py-4">
        <fieldset disabled={controlsDisabled} className="space-y-2">
          <legend className="sr-only">{t("toolchains.registry.sourceSelection")}</legend>
          {SOURCE_MODES.map((mode) => {
            const availability = profile.sources[mode];
            return (
              <label
                key={mode}
                className={`flex items-start gap-2 text-xs ${availability.available ? "cursor-pointer text-text-primary" : "cursor-not-allowed text-text-muted opacity-60"}`}
                title={availability.reasonCode
                  ? t(`toolchains.diagnostics.${availability.reasonCode}`)
                  : undefined}
              >
                <input
                  type="radio"
                  name={`toolchain-source-${profile.id}`}
                  value={mode}
                  checked={profile.selection.mode === mode}
                  disabled={controlsDisabled || !availability.available}
                  onChange={() => void applyPreference(mode)}
                  className="mt-0.5 accent-indigo-600"
                />
                <span>{t(`toolchains.registry.sources.${mode}`)}</span>
              </label>
            );
          })}
        </fieldset>

        {profile.selection.mode === "local_path" && (
          <div className="mt-3 space-y-2 rounded border border-surface-border bg-surface-elevated p-2.5">
            <input
              type="text"
              value={localPath}
              disabled={controlsDisabled}
              onChange={(event) => {
                setLocalPath(event.target.value);
                setPathDirty(true);
              }}
              placeholder={profile.kind === "cpp" ? "g++ / clang++" : "python / python3"}
              className="w-full rounded border border-surface-border-strong bg-input-bg px-2.5 py-1.5 font-mono text-2xs text-text-primary outline-none focus:border-indigo-500"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={controlsDisabled}
                onClick={() => void browse()}
                className="flex items-center gap-1 rounded border border-surface-border px-2 py-1 text-2xs font-bold text-text-primary hover:bg-surface-hover disabled:opacity-50"
              >
                <FolderOpen className="h-3.5 w-3.5" /> {t("directoryPicker.browse")}
              </button>
              <button
                type="button"
                disabled={controlsDisabled || !localPath.trim()}
                onClick={() => void applyPreference("local_path", localPath.trim())}
                className="rounded bg-indigo-600 px-2.5 py-1 text-2xs font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("toolchains.registry.verifyAndUse")}
              </button>
            </div>
          </div>
        )}

        {profile.selection.mode === "local_auto" && (
          <CandidateList
            profile={profile}
            discoveryStatus={discoveryStatus}
            disabled={controlsDisabled}
            onChoose={(candidatePath) => void applyPreference("local_path", candidatePath)}
          />
        )}
      </td>
      <td className="px-4 py-4">
        <div className="flex flex-col items-start gap-2">
          {managed && !managed.installed && (
            <button
              type="button"
              disabled={
                controlsDisabled
                || installing
                || !managed.downloadAvailable
              }
              onClick={() => void onInstall(managed.id)}
              className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-2xs font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {t("toolchains.registry.downloadAndApply")}
            </button>
          )}
          {managed?.installed && profile.selection.mode !== "managed" && (
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void applyPreference("managed")}
              className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-2xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {t("toolchains.registry.applyManaged")}
            </button>
          )}
          {installing && managed && (
            <>
              <div className="w-full max-w-44">
                <div className="mb-1 flex justify-between text-[10px] text-text-muted">
                  <span>{t(`toolchains.${managed.progress.status}`)}</span>
                  <span>{managed.progress.percent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-input-bg">
                  <div
                    className="h-full bg-indigo-600 transition-all"
                    style={{ width: `${managed.progress.percent}%` }}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onCancel(managed.id)}
                className="flex items-center gap-1 text-2xs font-bold text-rose-600 dark:text-rose-400"
              >
                <XCircle className="h-3.5 w-3.5" /> {t("toolchains.cancel")}
              </button>
            </>
          )}
          {managed?.installed && !installing && (
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => {
                if (window.confirm(t("toolchains.registry.uninstallConfirm"))) {
                  void onUninstall(managed.id);
                }
              }}
              className="flex items-center gap-1.5 rounded border border-rose-300 px-3 py-1.5 text-2xs font-bold text-rose-600 hover:bg-rose-500/10 disabled:opacity-50 dark:border-rose-900/60 dark:text-rose-400"
            >
              <Trash2 className="h-3.5 w-3.5" /> {t("toolchains.uninstall")}
            </button>
          )}
          {managed?.progress.status === "failed" && managed.progress.error && (
            <p className="max-w-52 break-words text-2xs leading-relaxed text-rose-600 dark:text-rose-400">
              {managed.progress.error}
            </p>
          )}
          {!managed && (
            <span className="text-2xs text-text-muted">
              {t("toolchains.registry.managedUnavailable")}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function CandidateList({
  profile,
  discoveryStatus,
  disabled,
  onChoose,
}: {
  profile: LanguageProfileView;
  discoveryStatus: "not_started" | "running" | "complete" | "failed";
  disabled: boolean;
  onChoose: (candidatePath: string) => void;
}) {
  const { t } = useTranslation();
  if (discoveryStatus === "running" || discoveryStatus === "not_started") {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-2xs text-text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("toolchains.registry.discovery.running")}
      </p>
    );
  }
  if (profile.candidates.length === 0) {
    return (
      <p className="mt-3 text-2xs text-text-muted">
        {t("toolchains.registry.noCandidates")}
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-1.5">
      <div className="text-2xs font-bold text-text-muted">
        {t("toolchains.registry.detectedCandidates", { count: profile.candidates.length })}
      </div>
      {profile.candidates.map((candidate) => (
        <button
          key={candidate.candidateId}
          type="button"
          disabled={disabled}
          onClick={() => onChoose(candidate.canonicalPath)}
          className="block w-full break-all rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-left font-mono text-[10px] text-text-primary hover:border-indigo-500 disabled:opacity-50"
        >
          {candidate.displayPath}
        </button>
      ))}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: LanguageProfileView["status"];
}) {
  const { t } = useTranslation();
  const styles = status === "submission_ready"
    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : status === "checker_only"
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "bg-rose-500/10 text-rose-600 dark:text-rose-400";
  const Icon = status === "submission_ready"
    ? CheckCircle2
    : status === "checker_only"
      ? ShieldCheck
      : AlertTriangle;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-1 text-2xs font-bold ${styles}`}>
      <Icon className="h-3.5 w-3.5" />
      {t(`toolchains.registry.statuses.${status}`)}
    </span>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const styles = tone === "info"
    ? "border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-900/40 dark:bg-indigo-950/20 dark:text-indigo-300"
    : tone === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
      : "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300";
  return (
    <div className={`flex items-start gap-2 rounded border px-3 py-2.5 text-xs ${styles}`}>
      {children}
    </div>
  );
}
