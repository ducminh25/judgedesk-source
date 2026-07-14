import React, { useState } from "react";
import { X, Cpu, ShieldCheck, AlertTriangle, HelpCircle } from "lucide-react";
import { useToolchains } from "./useToolchains.js";
import { ToolchainCard } from "./ToolchainCard.js";
import { useTranslation } from "react-i18next";

interface Props {
  onClose: () => void;
}

export default function ToolchainManager({ onClose }: Props) {
  const { t } = useTranslation();
  const {
    state,
    error,
    install,
    cancel,
    uninstall,
    saveCustomPath,
    savePreferredSource,
  } = useToolchains();
  const [cppPathInput, setCppPathInput] = useState("");
  const [pyPathInput, setPyPathInput] = useState("");
  const [activeTab, setActiveTab] = useState<"active" | "packages">("active");

  if (!state) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="bg-surface border border-surface-border rounded-lg w-full max-w-3xl shadow-2xl p-8 text-center text-text-muted">
          {error ? (
            <div className="space-y-4">
              <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto" />
              <p className="text-sm font-bold text-text-primary">
                {t("toolchains.loadError")}
              </p>
              <pre className="text-xs bg-input-bg p-3 rounded font-mono text-rose-600 dark:text-rose-400 overflow-x-auto">
                {error}
              </pre>
              <button
                onClick={onClose}
                className="px-5 py-2 bg-indigo-600 text-white rounded text-xs font-bold uppercase tracking-wider hover:bg-indigo-500 transition"
              >
                {t("problemConfig.cancel")}
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-3 border-indigo-600/30 border-t-indigo-600 rounded-full animate-spin" />
              <span className="text-xs font-semibold">
                {t("toolchains.loadingState")}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Find host-compatible toolchains to list under packages tab
  const hostToolchains = state.toolchains.filter(
    (t) => t.platform === state.platform && t.arch === state.arch,
  );
  const diagnosticText = (diagnostic?: string) => {
    if (!diagnostic) return "";
    if (diagnostic === "System compiler not found.")
      return t("toolchains.diagnostics.systemMissing");
    if (diagnostic === "Managed toolchain not installed.")
      return t("toolchains.diagnostics.managedMissing");
    if (diagnostic === "Custom compiler path does not exist or is invalid.")
      return t("toolchains.diagnostics.customInvalid");
    return diagnostic;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface border border-surface-border rounded-lg w-full max-w-4xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-surface-border bg-surface-elevated">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <Cpu className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-text-primary font-bold text-sm tracking-wider uppercase">
                {t("toolchains.managerTitle")}
              </h2>
            </div>
          </div>
          <button
            aria-label={t("toolchains.close")}
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-surface-border bg-surface-elevated/50 px-4">
          <button
            onClick={() => setActiveTab("active")}
            className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wider border-b-2 transition ${activeTab === "active" ? "border-indigo-600 text-indigo-600 dark:text-indigo-400" : "border-transparent text-text-muted hover:text-text-primary"}`}
          >
            {t("toolchains.tabActive")}
          </button>
          <button
            onClick={() => setActiveTab("packages")}
            className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wider border-b-2 transition ${activeTab === "packages" ? "border-indigo-600 text-indigo-600 dark:text-indigo-400" : "border-transparent text-text-muted hover:text-text-primary"}`}
          >
            {t("toolchains.tabPackages")}
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-6 bg-surface">
          {activeTab === "active" ? (
            <div className="space-y-6">
              {/* C++ Config Section */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center gap-1.5">
                  {t("toolchains.cppSettings")}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Status Panel */}
                  <div className="border border-surface-border rounded-lg p-4 bg-surface-elevated space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-text-primary">
                        {t("toolchains.status")}:
                      </span>
                      {state.active.cpp.ready ? (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
                          <ShieldCheck className="w-4 h-4" />{" "}
                          {t("toolchains.ready")}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400 text-xs font-bold">
                          <AlertTriangle className="w-4 h-4" />{" "}
                          {t("toolchains.notFound")}
                        </span>
                      )}
                    </div>
                    <div className="text-2xs font-mono space-y-1 text-text-muted">
                      <div>
                        <span className="font-bold">
                          {t("toolchains.activePath")}:
                        </span>{" "}
                        {state.active.cpp.executablePath || "-"}
                      </div>
                      <div>
                        <span className="font-bold">
                          {t("toolchains.version")}:
                        </span>{" "}
                        {state.active.cpp.version || "-"}
                      </div>
                      <div>
                        <span className="font-bold">
                          {t("toolchains.source")}:
                        </span>{" "}
                        <span className="uppercase text-indigo-600 dark:text-indigo-400 font-bold">
                          {state.active.cpp.source}
                        </span>
                      </div>
                      {state.active.cpp.diagnostic && (
                        <div className="text-rose-500 mt-2 p-1.5 bg-rose-500/5 rounded border border-rose-500/10">
                          {diagnosticText(state.active.cpp.diagnostic)}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Settings Override */}
                  <div className="border border-surface-border rounded-lg p-4 bg-surface-elevated space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-2xs font-bold uppercase text-text-muted">
                        {t("toolchains.prefSource")}
                      </label>
                      <select
                        value={state.preferences.preferredSourceCpp || "system"}
                        onChange={(e) =>
                          void savePreferredSource(
                            "cpp",
                            e.target.value as "managed" | "custom" | "system",
                          )
                        }
                        className="bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs w-full focus:border-indigo-500 outline-none"
                      >
                        <option value="system">
                          {t("toolchains.sourceSystem")}
                        </option>
                        <option value="managed">
                          {t("toolchains.sourceManaged")}
                        </option>
                        <option value="custom">
                          {t("toolchains.sourceCustom")}
                        </option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs font-bold uppercase text-text-muted">
                        {t("toolchains.customPath")}
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={
                            cppPathInput !== ""
                              ? cppPathInput
                              : state.preferences.customCppPath || ""
                          }
                          placeholder={
                            state.platform === "win32"
                              ? "C:\\path\\to\\g++.exe"
                              : "/usr/bin/g++"
                          }
                          onChange={(e) => setCppPathInput(e.target.value)}
                          className="bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs flex-1 focus:border-indigo-500 outline-none font-mono"
                        />
                        <button
                          onClick={() => {
                            if (cppPathInput.trim()) {
                              void saveCustomPath("cpp", cppPathInput.trim());
                              setCppPathInput("");
                            }
                          }}
                          className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-2xs font-bold uppercase tracking-wider transition cursor-pointer"
                        >
                          {t("problemConfig.save")}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Python Config Section */}
              <div className="space-y-3 pt-4 border-t border-surface-border">
                <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center gap-1.5">
                  {t("toolchains.pythonSettings")}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Status Panel */}
                  <div className="border border-surface-border rounded-lg p-4 bg-surface-elevated space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-text-primary">
                        {t("toolchains.status")}:
                      </span>
                      {state.active.python.ready ? (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
                          <ShieldCheck className="w-4 h-4" />{" "}
                          {t("toolchains.ready")}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400 text-xs font-bold">
                          <AlertTriangle className="w-4 h-4" />{" "}
                          {t("toolchains.notFound")}
                        </span>
                      )}
                    </div>
                    <div className="text-2xs font-mono space-y-1 text-text-muted">
                      <div>
                        <span className="font-bold">
                          {t("toolchains.activePath")}:
                        </span>{" "}
                        {state.active.python.executablePath || "-"}
                      </div>
                      <div>
                        <span className="font-bold">
                          {t("toolchains.version")}:
                        </span>{" "}
                        {state.active.python.version || "-"}
                      </div>
                      <div>
                        <span className="font-bold">
                          {t("toolchains.source")}:
                        </span>{" "}
                        <span className="uppercase text-indigo-600 dark:text-indigo-400 font-bold">
                          {state.active.python.source}
                        </span>
                      </div>
                      {state.active.python.diagnostic && (
                        <div className="text-rose-500 mt-2 p-1.5 bg-rose-500/5 rounded border border-rose-500/10">
                          {diagnosticText(state.active.python.diagnostic)}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Settings Override */}
                  <div className="border border-surface-border rounded-lg p-4 bg-surface-elevated space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-2xs font-bold uppercase text-text-muted">
                        {t("toolchains.prefSource")}
                      </label>
                      <select
                        value={
                          state.preferences.preferredSourcePython || "system"
                        }
                        onChange={(e) =>
                          void savePreferredSource(
                            "python",
                            e.target.value as "managed" | "custom" | "system",
                          )
                        }
                        className="bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs w-full focus:border-indigo-500 outline-none"
                      >
                        <option value="system">
                          {t("toolchains.sourceSystem")}
                        </option>
                        <option value="managed">
                          {t("toolchains.sourceManaged")}
                        </option>
                        <option value="custom">
                          {t("toolchains.sourceCustom")}
                        </option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs font-bold uppercase text-text-muted">
                        {t("toolchains.customPath")}
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={
                            pyPathInput !== ""
                              ? pyPathInput
                              : state.preferences.customPythonPath || ""
                          }
                          placeholder={
                            state.platform === "win32"
                              ? "C:\\path\\to\\python.exe"
                              : "/usr/bin/python3"
                          }
                          onChange={(e) => setPyPathInput(e.target.value)}
                          className="bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs flex-1 focus:border-indigo-500 outline-none font-mono"
                        />
                        <button
                          onClick={() => {
                            if (pyPathInput.trim()) {
                              void saveCustomPath("python", pyPathInput.trim());
                              setPyPathInput("");
                            }
                          }}
                          className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-2xs font-bold uppercase tracking-wider transition cursor-pointer"
                        >
                          {t("problemConfig.save")}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {state.manifestError && (
                <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>
                    {t("toolchains.manifestUnavailable")}: {state.manifestError}
                  </span>
                </div>
              )}
              <p className="text-xs text-text-muted flex items-center gap-1.5 bg-indigo-50 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-900/30 px-3 py-2.5 rounded">
                <HelpCircle className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                {t("toolchains.packagesDescription")}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {hostToolchains.map((t) => (
                  <ToolchainCard
                    key={t.id}
                    toolchain={t}
                    onInstall={install}
                    onCancel={cancel}
                    onUninstall={uninstall}
                  />
                ))}
                {hostToolchains.length === 0 && (
                  <div className="col-span-2 text-center py-12 text-text-muted border border-dashed border-surface-border rounded-lg">
                    {t("toolchains.noPackagesAvailable")}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-surface-border bg-surface-elevated flex justify-end gap-3 z-10">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold uppercase tracking-wider transition shadow cursor-pointer"
          >
            {t("toolchains.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
