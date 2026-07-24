import { Dispatch, SetStateAction, useState } from "react";
import { ProblemConfig } from "../../types";
import { useTranslation } from "react-i18next";
import {
  CHECKER_SOURCE_FILES,
  POLYGON_CHECKER_IDS,
  THEMIS_CHECKER_IDS,
  checkerTranslationKey,
  isBuiltInCheckerId,
} from "../../../shared/checker-catalog";

interface Props {
  problemName: string;
  config: ProblemConfig;
  setConfig: Dispatch<SetStateAction<ProblemConfig>>;
  customCheckers: string[];
  useStdIn: boolean;
  setUseStdIn: (value: boolean) => void;
  useStdOut: boolean;
  setUseStdOut: (value: boolean) => void;
  inputFile: string;
  setInputFile: (value: string) => void;
  outputFile: string;
  setOutputFile: (value: string) => void;
}

export function BasicProblemSettings(props: Props) {
  const { problemName, config, setConfig, customCheckers } = props;
  const { t } = useTranslation();
  const [sourceError, setSourceError] = useState("");
  const selectedChecker = config.checkerType || "C1";
  const selectedBuiltIn = isBuiltInCheckerId(selectedChecker)
    ? selectedChecker
    : null;
  const translationKey = selectedBuiltIn
    ? checkerTranslationKey(selectedBuiltIn)
    : null;

  const openSource = async () => {
    if (!selectedBuiltIn) return;
    setSourceError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_checker_source", { checkerId: selectedBuiltIn });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error));
    }
  };
  
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(260px,0.8fr)_minmax(520px,1.4fr)] gap-4">
        <FileSetting
          label={t("problemConfig.inputFile")}
          standardLabel="Use standard input"
          standardValue="stdin"
          fileValue={props.inputFile}
          useStandard={props.useStdIn}
          placeholder={`${problemName}.inp`}
          onStandardChange={props.setUseStdIn}
          onFileChange={props.setInputFile}
        />
        <FileSetting
          label={t("problemConfig.outputFile")}
          standardLabel="Use standard output"
          standardValue="stdout"
          fileValue={props.outputFile}
          useStandard={props.useStdOut}
          placeholder={`${problemName}.out`}
          onStandardChange={props.setUseStdOut}
          onFileChange={props.setOutputFile}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-center gap-2 bg-surface-elevated p-2.5 rounded border border-surface-border">
          <label className="text-text-primary text-[11px] font-semibold w-24">{t("problemConfig.memoryLimit")}</label>
          <input
            type="number"
            min={8}
            step={1}
            placeholder="256"
            value={config.memoryLimit ?? ""}
            onChange={event => setConfig(previous => ({ ...previous, memoryLimit: event.target.value ? Number(event.target.value) : undefined }))}
            className="flex-1 bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs focus:border-indigo-500 transition outline-none"
          />
          <span
            className="cursor-help text-[10px] text-text-muted"
            title={t("problemConfig.windowsMemoryPolicy")}
            aria-label={t("problemConfig.windowsMemoryPolicy")}
          >
            ⓘ
          </span>
        </div>
        <div className="flex items-center gap-2 bg-surface-elevated p-2.5 rounded border border-surface-border">
          <label className="text-text-primary text-[11px] font-semibold w-24">{t("problemConfig.checker")}</label>
          <select
            value={config.checkerType || "C1"}
            onChange={event => setConfig(previous => ({ ...previous, checkerType: event.target.value }))}
            className="min-w-0 flex-1 bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
          >
            {customCheckers.length > 0 && (
              <optgroup label={t("checkers.groups.custom")}>
                {customCheckers.map((checker) => (
                  <option key={checker} value={checker}>{checker}</option>
                ))}
              </optgroup>
            )}
            <optgroup label={t("checkers.groups.themis")}>
              {THEMIS_CHECKER_IDS.map((checker) => {
                const key = checkerTranslationKey(checker);
                return (
                  <option key={checker} value={checker}>
                    {t(`checkers.entries.${key}.title`)}
                  </option>
                );
              })}
            </optgroup>
            <optgroup label={t("checkers.groups.polygon")}>
              {POLYGON_CHECKER_IDS.map((checker) => {
                const key = checkerTranslationKey(checker);
                return (
                  <option key={checker} value={checker}>
                    {t(`checkers.entries.${key}.title`)} — {t(`checkers.entries.${key}.summary`)}
                  </option>
                );
              })}
            </optgroup>
          </select>
        </div>
      </div>
      <div className="rounded border border-surface-border bg-input-bg px-3 py-2 text-[11px] leading-relaxed text-text-muted">
        <p>
          {translationKey
            ? t(`checkers.entries.${translationKey}.description`)
            : t("checkers.customDescription", { name: selectedChecker })}
        </p>
        {selectedBuiltIn && (
          <button
            type="button"
            onClick={() => void openSource()}
            className="mt-1 font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            {t("checkers.viewSource")}: ({CHECKER_SOURCE_FILES[selectedBuiltIn]})
          </button>
        )}
        {sourceError && (
          <p className="mt-1 text-rose-500">
            {t("checkers.sourceOpenFailed")}: {sourceError}
          </p>
        )}
      </div>
    </>
  );
}

interface FileSettingProps {
  label: string;
  standardLabel: string;
  standardValue: string;
  fileValue: string;
  useStandard: boolean;
  placeholder: string;
  onStandardChange: (value: boolean) => void;
  onFileChange: (value: string) => void;
}

function FileSetting(props: FileSettingProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5 bg-surface-elevated p-3 rounded border border-surface-border">
      <div className="flex items-center justify-between">
        <span className="text-text-primary text-xs font-bold uppercase tracking-wider">{props.label}</span>
        <label className="flex items-center gap-1.5 text-text-muted text-2xs font-semibold cursor-pointer">
          <input type="checkbox" checked={props.useStandard} onChange={event => props.onStandardChange(event.target.checked)} className="w-3.5 h-3.5 rounded text-indigo-500 bg-input-bg border-surface-border-strong" />
          {props.label === t("problemConfig.inputFile") ? t("problemConfig.useStandardInput") : t("problemConfig.useStandardOutput")}
        </label>
      </div>
      <input
        type="text"
        value={props.useStandard ? props.standardValue : props.fileValue}
        disabled={props.useStandard}
        onChange={event => props.onFileChange(event.target.value)}
        placeholder={props.placeholder}
        className="bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs disabled:opacity-50 disabled:bg-surface-elevated disabled:text-text-muted outline-none focus:border-indigo-500 transition font-mono"
      />
    </div>
  );
}
