import { useEffect, useState } from "react";
import { AlertCircle, Settings, X } from "lucide-react";
import { ProblemConfig } from "../types";
import { BasicProblemSettings } from "../features/problem-config/BasicProblemSettings";
import { GroupPolicyTable } from "../features/problem-config/GroupPolicyTable";
import { TestConfigurationTable } from "../features/problem-config/TestConfigurationTable";
import { TestEditPopover } from "../features/problem-config/TestEditPopover";
import { TestEditPopover as PopoverState } from "../features/problem-config/editor-state";
import { useProblemConfigEditor } from "../features/problem-config/useProblemConfigEditor";
import {
  CompileProblemSettings,
  withProblemCompileConfig,
} from "../features/problem-config/CompileProblemSettings";
import { useTranslation } from "react-i18next";
import ProblemConfigSaveConfirmDialog from "./ProblemConfigSaveConfirmDialog";

interface Props {
  problemName: string;
  testPath: string;
  initialConfig: ProblemConfig;
  hasScoredResults?: boolean;
  onSave: (problemName: string, config: ProblemConfig) => void;
  onClose: () => void;
  customCheckers?: string[];
  interactors?: string[];
  saveDisabled?: boolean;
}

export default function ProblemConfigModal({
  problemName,
  testPath,
  initialConfig,
  hasScoredResults = false,
  onSave,
  onClose,
  customCheckers = [],
  interactors = [],
  saveDisabled = false,
}: Props) {
  const { t } = useTranslation();
  const editor = useProblemConfigEditor({
    problemName,
    testPath,
    initialConfig,
    onSave,
    onClose,
  });
  const [showContent, setShowContent] = useState(false);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [popoverInput, setPopoverInput] = useState("");
  const [batchPointsTotal, setBatchPointsTotal] = useState("");
  const [confirmingSave, setConfirmingSave] = useState(false);
  const [compileConfigValid, setCompileConfigValid] = useState(true);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (confirmingSave) {
          setConfirmingSave(false);
        } else if (popover) {
          setPopover(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [confirmingSave, onClose, popover]);

  const closePopover = () => setPopover(null);
  const savePopover = () => {
    if (!popover) return;
    editor.applyEdit(popover, popoverInput);
    closePopover();
  };
  const requestSave = () => {
    if (!compileConfigValid) return;
    if (hasScoredResults) {
      setConfirmingSave(true);
      return;
    }
    void editor.save();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        className="bg-surface border border-surface-border rounded-lg w-full max-w-6xl shadow-lg flex flex-col max-h-[95vh]"
        onClick={() => popover && closePopover()}
      >
        <div className="flex items-center justify-between p-4 border-b border-surface-border bg-surface-elevated">
          <h3 className="text-text-primary font-bold tracking-wider uppercase text-xs flex items-center gap-2">
            <Settings className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
            {t("problemConfig.title")}:{" "}
            <span className="text-indigo-500 dark:text-indigo-400">
              {problemName}
            </span>
          </h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition"
            aria-label={t("problemConfig.close")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 border-b border-surface-border space-y-3 bg-surface-elevated">
          {editor.loadError && (
            <div className="flex items-center gap-2 border border-rose-300 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/20 px-3 py-2 text-xs text-rose-600 dark:text-rose-300 rounded">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{" "}
              {editor.loadError}
            </div>
          )}
          {saveDisabled && (
            <div className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
              <AlertCircle className="h-4 w-4 flex-none" />
              {t("problemConfig.readOnlyWhileBusy")}
            </div>
          )}
          <BasicProblemSettings
            problemName={problemName}
            config={editor.config}
            setConfig={editor.setConfig}
            customCheckers={customCheckers}
            interactors={interactors}
            useStdIn={editor.useStdIn}
            setUseStdIn={editor.setUseStdIn}
            useStdOut={editor.useStdOut}
            setUseStdOut={editor.setUseStdOut}
            inputFile={editor.inputFile}
            setInputFile={editor.setInputFile}
            outputFile={editor.outputFile}
            setOutputFile={editor.setOutputFile}
            setTotalScore={editor.setTotalScore}
          />
        </div>

        <div className="p-5 flex-1 overflow-y-auto font-sans text-xs space-y-5 bg-surface">
          <div className="rounded-lg border border-surface-border bg-surface-elevated/50 p-4 shadow-xs">
            <CompileProblemSettings
              value={editor.config.compile}
              onChange={(compile) => {
                editor.setConfig((previous) => withProblemCompileConfig(previous, compile));
              }}
              onValidityChange={setCompileConfigValid}
            />
          </div>

          <div className="rounded-lg border border-surface-border bg-surface-elevated/50 p-4 shadow-xs space-y-4">
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-text-primary font-medium cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={editor.polygonConfig.enableGroups}
                  onChange={(event) =>
                    editor.setPolygonConfig((previous) => ({
                      ...previous,
                      enableGroups: event.target.checked,
                    }))
                  }
                  className="w-4 h-4 bg-input-bg border-surface-border-strong rounded text-indigo-500 focus:ring-indigo-500"
                />
                {t("problemConfig.enableGroups")}
              </label>
              <label className="flex items-center gap-2 text-text-primary font-medium cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showContent}
                  onChange={(event) => setShowContent(event.target.checked)}
                  className="w-4 h-4 bg-input-bg border-surface-border-strong rounded text-indigo-500 focus:ring-indigo-500"
                />
                {t("problemConfig.showContent")}
              </label>
            </div>

            <TestConfigurationTable
              config={editor.polygonConfig}
              tests={editor.testDetails}
              selectedTests={editor.selectedTests}
              showContent={showContent}
              isLoading={editor.isLoading}
              totalPoints={editor.totalPoints}
              onToggleAll={editor.toggleAllTests}
              onToggleTest={editor.toggleTest}
              onOpenEdit={(nextPopover, input, batchTotal) => {
                setPopover(nextPopover);
                setPopoverInput(input);
                if (batchTotal !== undefined) setBatchPointsTotal(batchTotal);
              }}
            />
          </div>

          <div className="rounded-lg border border-surface-border bg-surface-elevated/50 p-4 shadow-xs">
            <GroupPolicyTable
              config={editor.polygonConfig}
              onConfigChange={editor.setPolygonConfig}
              onAddDependency={editor.addDependency}
              onRemoveDependency={editor.removeDependency}
            />
          </div>
        </div>

        <div className="p-4 border-t border-surface-border bg-surface-elevated flex justify-end gap-3 z-10">
          {editor.saveError && (
            <span className="mr-auto self-center text-xs text-rose-500 dark:text-rose-400">
              {editor.saveError}
            </span>
          )}
          {!compileConfigValid && !editor.saveError && (
            <span className="mr-auto self-center text-xs text-rose-500 dark:text-rose-400">
              {t("problemConfig.compile.saveBlocked")}
            </span>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-text-muted hover:text-text-primary transition"
          >
            {t("problemConfig.cancel")}
          </button>
          <button
            disabled={editor.isSaving || saveDisabled || !compileConfigValid}
            onClick={requestSave}
            className="px-5 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded shadow transition"
          >
            {editor.isSaving
              ? t("problemConfig.saving")
              : t("problemConfig.save")}
          </button>
        </div>

        {popover && (
          <TestEditPopover
            popover={popover}
            input={popoverInput}
            batchPointsTotal={batchPointsTotal}
            selectedCount={editor.selectedTests.size}
            onInputChange={setPopoverInput}
            onBatchPointsTotalChange={setBatchPointsTotal}
            onCancel={closePopover}
            onSave={savePopover}
          />
        )}
      </div>
      {confirmingSave && (
        <ProblemConfigSaveConfirmDialog
          disabled={editor.isSaving || saveDisabled || !compileConfigValid}
          problemName={problemName}
          onCancel={() => setConfirmingSave(false)}
          onConfirm={() => {
            setConfirmingSave(false);
            void editor.save();
          }}
        />
      )}
    </div>
  );
}
