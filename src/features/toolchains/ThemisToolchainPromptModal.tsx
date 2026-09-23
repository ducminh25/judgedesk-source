import React, { useState } from "react";
import {
  CheckCircle2,
  Cpu,
  HelpCircle,
  Layers,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { preferencesStorage, type ThemisPromptChoice } from "../preferences/storage.js";

export interface DetectedThemisToolchain {
  profileId: string;
  kind: string;
  name: string;
  path: string;
  version?: string;
}

export interface ManagedToolchainInfo {
  profileId: string;
  kind: string;
  name: string;
  version: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  themisToolchains: DetectedThemisToolchain[];
  managedToolchains: ManagedToolchainInfo[];
  onApplyManaged: () => Promise<void>;
  onApplyThemis: () => Promise<void>;
  onSuccessToast: (message: string) => void;
}

export default function ThemisToolchainPromptModal({
  isOpen,
  onClose,
  themisToolchains,
  managedToolchains,
  onApplyManaged,
  onApplyThemis,
  onSuccessToast,
}: Props) {
  const { t } = useTranslation();
  const [selectedChoice, setSelectedChoice] = useState<"managed" | "themis" | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  if (!isOpen) return null;

  const handleSelectChoice = (choice: "managed" | "themis") => {
    setSelectedChoice(choice);
  };

  const handleConfirmApply = async () => {
    if (!selectedChoice) return;
    setIsApplying(true);
    try {
      if (selectedChoice === "managed") {
        await onApplyManaged();
        preferencesStorage.setThemisPromptChoice("managed");
        onSuccessToast(t("toolchains.themisPrompt.successManaged"));
      } else {
        await onApplyThemis();
        preferencesStorage.setThemisPromptChoice("themis");
        onSuccessToast(t("toolchains.themisPrompt.successThemis"));
      }
      onClose();
    } catch (err) {
      console.error("Failed to apply toolchain choice:", err);
    } finally {
      setIsApplying(false);
    }
  };

  const handleDismiss = () => {
    preferencesStorage.setThemisPromptChoice("dismissed");
    onClose();
  };

  // Step 2: Confirmation Dialog
  if (selectedChoice !== null) {
    const isManaged = selectedChoice === "managed";
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
        <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-surface-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated p-4">
            <div className="flex items-center gap-3">
              <div className={`rounded-md p-2 ${isManaged ? "bg-indigo-500/10 text-indigo-500" : "bg-amber-500/10 text-amber-500"}`}>
                <PackageCheck className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-text-primary">
                  {isManaged
                    ? t("toolchains.themisPrompt.confirmManagedTitle")
                    : t("toolchains.themisPrompt.confirmThemisTitle")}
                </h3>
                <p className="text-xs text-text-muted">
                  {t("toolchains.themisPrompt.confirmSubtitle")}
                </p>
              </div>
            </div>
            {!isApplying && (
              <button
                type="button"
                onClick={() => setSelectedChoice(null)}
                className="text-text-muted hover:text-text-primary p-1"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="p-5 space-y-4 text-xs text-text-primary overflow-y-auto">
            <p className="leading-relaxed text-text-muted">
              {isManaged
                ? t("toolchains.themisPrompt.confirmManagedDesc")
                : t("toolchains.themisPrompt.confirmThemisDesc")}
            </p>

            <div className="rounded-lg border border-surface-border bg-surface-elevated p-3.5 space-y-2">
              <span className="font-semibold text-text-primary block text-2xs uppercase tracking-wider">
                {t("toolchains.themisPrompt.affectedLanguages")}:
              </span>
              <ul className="space-y-1.5 pl-1 text-2xs text-text-muted">
                {isManaged ? (
                  managedToolchains.map((item) => (
                    <li key={item.profileId} className="flex items-center justify-between">
                      <span className="font-medium text-text-primary">{item.name}</span>
                      <span className="font-mono text-indigo-500 dark:text-indigo-400">{item.version} (64-bit)</span>
                    </li>
                  ))
                ) : (
                  themisToolchains.map((item) => (
                    <li key={item.profileId} className="flex flex-col gap-0.5 border-b border-surface-border/50 pb-1.5 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-text-primary">{item.name}</span>
                        <span className="font-mono text-amber-500 dark:text-amber-400">{item.version || "32-bit Themis"}</span>
                      </div>
                      <span className="truncate font-mono text-[10px] text-text-muted" title={item.path}>
                        {item.path}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-3 text-2xs leading-relaxed text-sky-800 dark:text-sky-200 flex items-start gap-2.5">
              <HelpCircle className="h-4 w-4 flex-none mt-0.5 text-sky-500" />
              <div>
                <strong>{t("toolchains.themisPrompt.noteTitle")}:</strong>{" "}
                {t("toolchains.themisPrompt.alwaysChangeableHint")}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2.5 border-t border-surface-border bg-surface-elevated px-5 py-3.5">
            <button
              type="button"
              disabled={isApplying}
              onClick={() => setSelectedChoice(null)}
              className="rounded border border-surface-border bg-input-bg px-3.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-surface-hover disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={isApplying}
              onClick={() => void handleConfirmApply()}
              className={`rounded px-4 py-1.5 text-xs font-bold text-white shadow transition-colors disabled:opacity-50 ${
                isManaged
                  ? "bg-indigo-600 hover:bg-indigo-500"
                  : "bg-amber-600 hover:bg-amber-500"
              }`}
            >
              {isApplying
                ? t("toolchains.themisPrompt.applying")
                : t("toolchains.themisPrompt.confirmAction")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step 1: Side-by-Side Comparison Dialog
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-surface-border bg-surface shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-indigo-500/10 p-2 text-indigo-500 dark:text-indigo-400">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-text-primary">
                {t("toolchains.themisPrompt.title")}
              </h2>
              <p className="mt-0.5 text-xs text-text-muted">
                {t("toolchains.themisPrompt.subtitle")}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={handleDismiss}
            className="text-text-muted hover:text-text-primary p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3.5 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-3">
            <Wrench className="h-5 w-5 flex-none mt-0.5 text-amber-500" />
            <div className="space-y-1">
              <div className="font-bold">
                {t("toolchains.themisPrompt.detectedThemisBannerTitle")}
              </div>
              <p className="text-2xs leading-relaxed opacity-90">
                {t("toolchains.themisPrompt.detectedThemisBannerDesc")}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 pt-1">
                {themisToolchains.map((tool) => (
                  <span
                    key={tool.profileId}
                    className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-950 dark:text-amber-100"
                    title={tool.path}
                  >
                    <span>{tool.name}:</span>
                    <span className="font-normal opacity-80 truncate max-w-[260px]">{tool.path}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Comparison Cards */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Card 1: Olympic Standard (64-bit Managed) */}
            <div className="flex flex-col justify-between rounded-lg border border-indigo-500/60 bg-surface-elevated p-4 shadow-xs transition-all hover:border-indigo-500">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-indigo-500" />
                    <h3 className="text-sm font-bold text-text-primary">
                      {t("toolchains.themisPrompt.managedTitle")}
                    </h3>
                  </div>
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700 dark:bg-emerald-950/80 dark:text-emerald-300">
                    {t("toolchains.themisPrompt.recommendedBadge")}
                  </span>
                </div>

                <p className="text-2xs leading-relaxed text-text-muted">
                  {t("toolchains.themisPrompt.managedDescription")}
                </p>

                <div className="rounded-lg border border-surface-border bg-surface p-3 space-y-2 text-2xs">
                  <div className="flex items-center justify-between border-b border-surface-border/50 pb-1.5">
                    <span className="text-text-muted">{t("toolchains.themisPrompt.archLabel")}:</span>
                    <span className="font-bold text-text-primary">64-bit (x64)</span>
                  </div>
                  <div className="flex items-center justify-between border-b border-surface-border/50 pb-1.5">
                    <span className="text-text-muted">{t("toolchains.themisPrompt.standardLabel")}:</span>
                    <span className="font-semibold text-indigo-500 dark:text-indigo-400">IOI / VNOJ / Codeforces / VOI</span>
                  </div>
                  <div className="space-y-1 pt-1">
                    <span className="text-text-muted block">{t("toolchains.themisPrompt.versionListLabel")}:</span>
                    <ul className="list-disc pl-4 space-y-0.5 text-text-primary font-mono text-[11px]">
                      {managedToolchains.map((t) => (
                        <li key={t.profileId}>
                          {t.name}: <strong>{t.version}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <ul className="space-y-1.5 text-2xs text-text-muted">
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-none mt-0.5" />
                    <span>{t("toolchains.themisPrompt.featureManaged1")}</span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-none mt-0.5" />
                    <span>{t("toolchains.themisPrompt.featureManaged2")}</span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-none mt-0.5" />
                    <span>{t("toolchains.themisPrompt.featureManaged3")}</span>
                  </li>
                </ul>
              </div>

              <div className="mt-4 pt-3 border-t border-surface-border">
                <button
                  type="button"
                  onClick={() => handleSelectChoice("managed")}
                  className="w-full rounded bg-indigo-600 py-2 text-xs font-bold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 transition-colors flex items-center justify-center gap-1.5"
                >
                  <ShieldCheck className="h-4 w-4" />
                  {t("toolchains.themisPrompt.chooseManagedAction")}
                </button>
              </div>
            </div>

            {/* Card 2: Themis Compatibility Mode (32-bit Local) */}
            <div className="flex flex-col justify-between rounded-lg border border-surface-border bg-surface-elevated p-4 shadow-xs transition-all hover:border-amber-400">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-amber-500" />
                    <h3 className="text-sm font-bold text-text-primary">
                      {t("toolchains.themisPrompt.themisTitle")}
                    </h3>
                  </div>
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-800 dark:bg-amber-950/80 dark:text-amber-300">
                    {t("toolchains.themisPrompt.themisBadge")}
                  </span>
                </div>

                <p className="text-2xs leading-relaxed text-text-muted">
                  {t("toolchains.themisPrompt.themisDescription")}
                </p>

                <div className="rounded-lg border border-surface-border bg-surface p-3 space-y-2 text-2xs">
                  <div className="flex items-center justify-between border-b border-surface-border/50 pb-1.5">
                    <span className="text-text-muted">{t("toolchains.themisPrompt.archLabel")}:</span>
                    <span className="font-bold text-amber-600 dark:text-amber-400">32-bit (x86)</span>
                  </div>
                  <div className="flex items-center justify-between border-b border-surface-border/50 pb-1.5">
                    <span className="text-text-muted">{t("toolchains.themisPrompt.standardLabel")}:</span>
                    <span className="font-semibold text-amber-600 dark:text-amber-400">Themis Legacy (HSG Tỉnh)</span>
                  </div>
                  <div className="space-y-1 pt-1">
                    <span className="text-text-muted block">{t("toolchains.themisPrompt.detectedVersionsLabel")}:</span>
                    <ul className="list-disc pl-4 space-y-0.5 text-text-primary font-mono text-[11px]">
                      {themisToolchains.map((t) => (
                        <li key={t.profileId}>
                          {t.name}: <strong>{t.version || "Themis 32-bit"}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <ul className="space-y-1.5 text-2xs text-text-muted">
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-amber-500 flex-none mt-0.5" />
                    <span>{t("toolchains.themisPrompt.featureThemis1")}</span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-amber-500 flex-none mt-0.5" />
                    <span>{t("toolchains.themisPrompt.featureThemis2")}</span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-amber-500 flex-none mt-0.5" />
                    <span>{t("toolchains.themisPrompt.featureThemis3")}</span>
                  </li>
                </ul>
              </div>

              <div className="mt-4 pt-3 border-t border-surface-border">
                <button
                  type="button"
                  onClick={() => handleSelectChoice("themis")}
                  className="w-full rounded border border-amber-500/50 bg-amber-500/10 py-2 text-xs font-bold text-amber-800 dark:text-amber-200 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Wrench className="h-4 w-4" />
                  {t("toolchains.themisPrompt.chooseThemisAction")}
                </button>
              </div>
            </div>
          </div>

          <p className="text-center text-2xs text-text-muted pt-2">
            💡 {t("toolchains.themisPrompt.footerNote")}
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-surface-border bg-surface-elevated px-5 py-3.5">
          <span className="text-2xs text-text-muted">
            {t("toolchains.themisPrompt.rememberChoiceHint")}
          </span>
          <button
            type="button"
            onClick={handleDismiss}
            className="rounded border border-surface-border bg-input-bg px-4 py-1.5 text-xs font-medium text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors"
          >
            {t("toolchains.themisPrompt.decideLater")}
          </button>
        </div>
      </div>
    </div>
  );
}
