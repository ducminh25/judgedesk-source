import React, { useState, useEffect } from "react";
import {
  Cpu,
  Terminal,
  ArrowRight,
  Download,
  CheckCircle,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { preferencesStorage } from "../preferences/storage.js";
import { useToolchains } from "./useToolchains.js";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type PresetOption = "judger" | "cpp" | "python" | "both";

export function ToolchainSetupModal({ isOpen, onClose }: Props) {
  const { t } = useTranslation();
  const { state, error, install, cancel } = useToolchains();
  const [selectedPreset, setSelectedPreset] = useState<PresetOption>("both");
  const [step, setStep] = useState<"choose" | "installing" | "complete">(
    "choose",
  );
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !state) return;

    // Transition state based on installer progress
    if (step === "installing") {
      const activePkgIds = getRequiredPackageIds();
      const activePkgs = state.toolchains.filter((tc) =>
        activePkgIds.includes(tc.id),
      );

      const failedPackage = activePkgs.find(
        (tc) => tc.progress.status === "failed",
      );
      if (failedPackage) {
        setSetupError(failedPackage.progress.error || t("toolchains.failed"));
      }
      const allSuccess = activePkgs.every(
        (tc) => tc.installed || tc.progress.status === "success",
      );
      if (
        allSuccess &&
        activePkgs.length === activePkgIds.length &&
        activePkgs.length > 0
      ) {
        setStep("complete");
      }
    }
  }, [state, isOpen, step]);

  if (!isOpen || !state) return null;

  const getRequiredPackageIds = () => {
    const list: string[] = [];
    const isWin = state.platform === "win32";
    if (selectedPreset === "cpp" || selectedPreset === "both") {
      if (isWin) list.push("gcc-windows-x64");
    }
    if (selectedPreset === "python" || selectedPreset === "both") {
      if (isWin) list.push("python-windows-x64");
      else {
        // macOS
        if (state.arch === "arm64") list.push("python-macos-arm64");
        else list.push("python-macos-x64");
      }
    }
    return list;
  };

  const handleStartSetup = async () => {
    setSetupError(null);
    if (selectedPreset === "judger") {
      handleComplete();
      return;
    }

    const needsCpp = selectedPreset === "cpp" || selectedPreset === "both";
    if (state.platform === "darwin" && needsCpp && !state.active.cpp.ready) {
      setSetupError(t("toolchains.setup.macCppMissing"));
      return;
    }

    const packageIds = getRequiredPackageIds();
    if (packageIds.length === 0) {
      setStep("complete");
      return;
    }
    const availableIds = new Set(
      state.toolchains.map((toolchain) => toolchain.id),
    );
    if (packageIds.some((id) => !availableIds.has(id))) {
      setSetupError(
        state.manifestError || t("toolchains.setup.packagesUnavailable"),
      );
      return;
    }
    setStep("installing");
    const started = await Promise.all(packageIds.map((id) => install(id)));
    if (started.some((result) => !result)) {
      setSetupError(error || t("toolchains.setup.installStartFailed"));
    }
  };

  const handleComplete = () => {
    preferencesStorage.setToolchainSetupCompleted();
    onClose();
  };

  const activePkgIds = getRequiredPackageIds();
  const activePkgs = state.toolchains.filter((tc) =>
    activePkgIds.includes(tc.id),
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="bg-surface border border-surface-border rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header decoration */}
        <div className="bg-gradient-to-r from-indigo-600 via-indigo-500 to-indigo-700 p-6 text-white flex items-center gap-4 relative overflow-hidden flex-shrink-0">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl transform translate-x-12 -translate-y-12" />
          <div className="p-3 bg-white/10 rounded-lg">
            <Cpu className="w-6 h-6 text-white" />
          </div>
          <div>
            <h2 className="text-base font-bold uppercase tracking-wider">
              {t("toolchains.setup.title")}
            </h2>
            <p className="text-2xs text-white/80 font-medium mt-0.5">
              {t("toolchains.setup.subtitle")}
            </p>
          </div>
        </div>

        {/* Step Content */}
        <div className="p-6 overflow-y-auto flex-1 bg-surface space-y-6">
          {step === "choose" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Option 1: Both */}
                <PresetCard
                  id="both"
                  title={t("toolchains.setup.bothTitle")}
                  description={t(
                    state.platform === "darwin"
                      ? "toolchains.setup.bothDescMac"
                      : "toolchains.setup.bothDesc",
                  )}
                  icon={<Sparkles className="w-5 h-5 text-indigo-500" />}
                  selected={selectedPreset === "both"}
                  onClick={() => setSelectedPreset("both")}
                />

                {/* Option 2: C++ */}
                <PresetCard
                  id="cpp"
                  title={t("toolchains.setup.cppTitle")}
                  description={t(
                    state.platform === "darwin"
                      ? "toolchains.setup.cppDescMac"
                      : "toolchains.setup.cppDesc",
                  )}
                  icon={<Terminal className="w-5 h-5 text-emerald-500" />}
                  selected={selectedPreset === "cpp"}
                  onClick={() => setSelectedPreset("cpp")}
                />

                {/* Option 3: Python */}
                <PresetCard
                  id="python"
                  title={t("toolchains.setup.pythonTitle")}
                  description={t("toolchains.setup.pythonDesc")}
                  icon={<Terminal className="w-5 h-5 text-amber-500" />}
                  selected={selectedPreset === "python"}
                  onClick={() => setSelectedPreset("python")}
                />

                {/* Option 4: Judger only */}
                <PresetCard
                  id="judger"
                  title={t("toolchains.setup.judgerTitle")}
                  description={t("toolchains.setup.judgerDesc")}
                  icon={<ShieldAlert className="w-5 h-5 text-text-muted" />}
                  selected={selectedPreset === "judger"}
                  onClick={() => setSelectedPreset("judger")}
                />
              </div>

              {(setupError ||
                (state.manifestError && activePkgIds.length > 0)) &&
                selectedPreset !== "judger" && (
                  <div className="flex items-start gap-2 rounded border border-rose-300 bg-rose-50 px-3 py-2.5 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                    <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <span>
                      {setupError ||
                        `${t("toolchains.manifestUnavailable")}: ${state.manifestError}`}
                    </span>
                  </div>
                )}

              <div className="flex items-center justify-between pt-4 border-t border-surface-border">
                <button
                  onClick={handleComplete}
                  className="px-4 py-2 text-xs font-semibold text-text-muted hover:text-text-primary transition"
                >
                  {t("toolchains.setup.skip")}
                </button>
                <button
                  onClick={() => void handleStartSetup()}
                  className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold uppercase tracking-wider transition shadow-lg shadow-indigo-900/20 cursor-pointer"
                >
                  {t("toolchains.setup.next")}{" "}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === "installing" && (
            <div className="space-y-6 py-4">
              <div className="text-center space-y-2">
                <div className="w-10 h-10 border-4 border-indigo-600/30 border-t-indigo-600 rounded-full animate-spin mx-auto mb-2" />
                <h3 className="text-sm font-bold text-text-primary">
                  {t("toolchains.setup.installingTitle")}
                </h3>
                <p className="text-xs text-text-muted">
                  {t("toolchains.setup.installingDesc")}
                </p>
              </div>

              <div className="space-y-4 max-w-md mx-auto">
                {activePkgs.map((pkg) => {
                  const percent = pkg.progress.percent || 0;
                  return (
                    <div
                      key={pkg.id}
                      className="border border-surface-border rounded-lg p-3 bg-surface-elevated space-y-2"
                    >
                      <div className="flex justify-between text-xs font-bold text-text-primary">
                        <span>
                          {pkg.kind === "cpp"
                            ? t("toolchains.cppCompiler")
                            : t("toolchains.pythonRuntime")}
                        </span>
                        <span className="font-mono text-indigo-500">
                          {t(`toolchains.${pkg.progress.status}`)} ({percent}%)
                        </span>
                      </div>
                      <div className="w-full bg-input-bg border border-surface-border-strong rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-indigo-600 h-full transition-all duration-300"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      {pkg.progress.error && (
                        <p className="text-[10px] text-rose-500 font-medium bg-rose-500/5 p-1.5 rounded border border-rose-500/10 mt-1">
                          {pkg.progress.error}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-center pt-4">
                {setupError && (
                  <button
                    onClick={() => {
                      setStep("choose");
                      setSetupError(null);
                    }}
                    className="mr-3 px-5 py-2 bg-surface-elevated hover:bg-surface-hover text-text-primary rounded text-xs font-bold uppercase tracking-wider transition cursor-pointer border border-surface-border"
                  >
                    {t("toolchains.setup.back")}
                  </button>
                )}
                <button
                  onClick={() => activePkgs.forEach((p) => cancel(p.id))}
                  className="px-5 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded text-xs font-bold uppercase tracking-wider transition cursor-pointer"
                >
                  {t("toolchains.cancel")}
                </button>
              </div>
            </div>
          )}

          {step === "complete" && (
            <div className="space-y-6 text-center py-6">
              <div className="inline-flex p-3 bg-emerald-500/10 rounded-full text-emerald-500 mb-2 animate-bounce">
                <CheckCircle className="w-12 h-12" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-bold text-text-primary">
                  {t("toolchains.setup.successTitle")}
                </h3>
                <p className="text-xs text-text-muted max-w-md mx-auto">
                  {t("toolchains.setup.successDesc")}
                </p>
              </div>

              <div className="pt-6">
                <button
                  onClick={handleComplete}
                  className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold uppercase tracking-wider transition shadow-lg shadow-indigo-900/20 cursor-pointer"
                >
                  {t("toolchains.setup.finish")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface CardProps {
  id: PresetOption;
  title: string;
  description: string;
  icon: React.ReactNode;
  selected: boolean;
  onClick: () => void;
}

function PresetCard({
  title,
  description,
  icon,
  selected,
  onClick,
}: CardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border rounded-lg p-4 cursor-pointer flex gap-3 text-left transition-all hover:shadow-md ${selected ? "border-indigo-600 bg-indigo-500/5 ring-1 ring-indigo-600/30" : "border-surface-border bg-surface-elevated hover:border-surface-border-strong"}`}
    >
      <div className="mt-1 flex-shrink-0">{icon}</div>
      <div className="space-y-1">
        <h4 className="text-xs font-bold text-text-primary">{title}</h4>
        <p className="text-2xs text-text-muted font-medium leading-relaxed">
          {description}
        </p>
      </div>
    </button>
  );
}
