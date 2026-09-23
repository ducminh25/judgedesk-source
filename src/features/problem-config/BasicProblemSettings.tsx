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
  interactors?: string[];
  useStdIn: boolean;
  setUseStdIn: (value: boolean) => void;
  useStdOut: boolean;
  setUseStdOut: (value: boolean) => void;
  inputFile: string;
  setInputFile: (value: string) => void;
  outputFile: string;
  setOutputFile: (value: string) => void;
  setTotalScore?: (value: string | null) => void;
}

export function BasicProblemSettings(props: Props) {
  const { problemName, config, setConfig, customCheckers, interactors = [] } = props;
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

  const isInteractive = config.isInteractive ?? false;
  
  return (
    <>
      <div className="flex flex-col gap-2 bg-surface-elevated p-3 rounded border border-surface-border">
        <div className="flex items-center justify-between">
          <label
            className="flex items-center gap-2 cursor-pointer select-none"
            title={t(
              "problemConfig.interactiveTooltip",
              "Bật chế độ bài tập tương tác (Interactive Problem) theo quy chuẩn Codeforces Polygon. Lời giải của thí sinh và Interactor sẽ chạy song song và giao tiếp 2 chiều qua stdin/stdout trong sandbox biệt lập."
            )}
          >
            <input
              type="checkbox"
              checked={isInteractive}
              onChange={event => {
                const checked = event.target.checked;
                setConfig(previous => ({
                  ...previous,
                  isInteractive: checked,
                  interactor: previous.interactor || (interactors[0] || "interactor.cpp"),
                }));
                if (checked) {
                  props.setUseStdIn(true);
                  props.setUseStdOut(true);
                }
              }}
              className="w-4 h-4 rounded text-indigo-500 bg-input-bg border-surface-border-strong focus:ring-indigo-500"
            />
            <span className="text-text-primary text-xs font-bold uppercase tracking-wider">
              Interactive?
            </span>
          </label>
          {isInteractive && (
            <span className="text-[11px] text-indigo-600 dark:text-indigo-400 font-medium">
              {t("problemConfig.polygonStandard", "Chuẩn Polygon testlib.h")}
            </span>
          )}
        </div>

        {isInteractive && (
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-surface-border">
            <label className="text-text-primary text-[11px] font-semibold w-24">
              {t("problemConfig.interactor", "Interactor")}
            </label>
            {interactors.length > 0 ? (
              <select
                value={config.interactor || interactors[0]}
                onChange={event => setConfig(previous => ({ ...previous, interactor: event.target.value }))}
                className="min-w-0 flex-1 bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer font-mono"
              >
                {interactors.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.interactor || "interactor.cpp"}
                onChange={event => setConfig(previous => ({ ...previous, interactor: event.target.value }))}
                placeholder="interactor.cpp"
                className="flex-1 bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs focus:border-indigo-500 transition outline-none font-mono"
              />
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(260px,0.8fr)_minmax(520px,1.4fr)] gap-4">
        <FileSetting
          label={t("problemConfig.inputFile")}
          standardLabel="Use standard input"
          standardValue="stdin"
          fileValue={props.inputFile}
          useStandard={isInteractive || props.useStdIn}
          locked={isInteractive}
          placeholder={`${problemName}.inp`}
          onStandardChange={props.setUseStdIn}
          onFileChange={props.setInputFile}
        />
        <FileSetting
          label={t("problemConfig.outputFile")}
          standardLabel="Use standard output"
          standardValue="stdout"
          fileValue={props.outputFile}
          useStandard={isInteractive || props.useStdOut}
          locked={isInteractive}
          placeholder={`${problemName}.out`}
          onStandardChange={props.setUseStdOut}
          onFileChange={props.setOutputFile}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="flex items-center gap-2 bg-surface-elevated p-2.5 rounded border border-surface-border">
          <label className="text-text-primary text-[11px] font-semibold w-24 whitespace-nowrap">{t("problemConfig.totalScore", "Tổng điểm")}</label>
          <input
            type="text"
            placeholder={t("problemConfig.totalScorePlaceholder", "Tùy chọn (vd: 100/3, 10)")}
            value={config.totalScore !== null && config.totalScore !== undefined ? String(config.totalScore) : ""}
            onChange={event => {
              const val = event.target.value;
              const normalized = val.trim() ? val.trim() : null;
              if (props.setTotalScore) {
                props.setTotalScore(normalized);
              } else {
                setConfig(previous => ({
                  ...previous,
                  totalScore: normalized,
                }));
              }
            }}
            className="flex-1 min-w-0 bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs focus:border-indigo-500 transition outline-none font-mono"
          />
        </div>
        <div className="flex items-center gap-2 bg-surface-elevated p-2.5 rounded border border-surface-border">
          <label className="text-text-primary text-[11px] font-semibold w-24">{t("problemConfig.memoryLimit")}</label>
          <input
            type="number"
            min={8}
            max={1024}
            step={1}
            placeholder="256"
            value={config.memoryLimit ?? ""}
            onChange={event => {
              const val = event.target.value;
              if (!val) {
                setConfig(previous => ({ ...previous, memoryLimit: undefined }));
                return;
              }
              const parsed = Number(val);
              if (Number.isFinite(parsed)) {
                setConfig(previous => ({
                  ...previous,
                  memoryLimit: parsed > 1024 ? 1024 : parsed,
                }));
              }
            }}
            className="flex-1 min-w-0 bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs focus:border-indigo-500 transition outline-none"
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
          <label className="text-text-primary text-[11px] font-semibold w-16">{t("problemConfig.checker")}</label>
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
  locked?: boolean;
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
        <label className={`flex items-center gap-1.5 text-text-muted text-2xs font-semibold ${props.locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            checked={props.useStandard}
            disabled={props.locked}
            onChange={event => props.onStandardChange(event.target.checked)}
            className="w-3.5 h-3.5 rounded text-indigo-500 bg-input-bg border-surface-border-strong disabled:opacity-50"
          />
          {props.label === t("problemConfig.inputFile") ? t("problemConfig.useStandardInput") : t("problemConfig.useStandardOutput")}
        </label>
      </div>
      <input
        type="text"
        value={props.useStandard ? props.standardValue : props.fileValue}
        disabled={props.useStandard || props.locked}
        onChange={event => props.onFileChange(event.target.value)}
        placeholder={props.placeholder}
        className="bg-input-bg border border-surface-border-strong rounded px-2.5 py-1.5 text-text-primary text-xs disabled:opacity-50 disabled:bg-surface-elevated disabled:text-text-muted outline-none focus:border-indigo-500 transition font-mono"
      />
    </div>
  );
}
