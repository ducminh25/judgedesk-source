import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import type { ProblemConfig } from "../types";
import { BasicProblemSettings } from "../features/problem-config/BasicProblemSettings";
import { GroupPolicyTable } from "../features/problem-config/GroupPolicyTable";
import { GroupEditDialog } from "../features/problem-config/GroupEditDialog";
import { TestConfigurationTable } from "../features/problem-config/TestConfigurationTable";
import { TestEditPopover } from "../features/problem-config/TestEditPopover";
import type { TestEditPopover as PopoverState } from "../features/problem-config/editor-state";
import { parseTestSelection } from "../features/problem-config/test-selection";
import { useProblemConfigEditor } from "../features/problem-config/useProblemConfigEditor";
import { CompileProblemSettings, withProblemCompileConfig } from "../features/problem-config/CompileProblemSettings";
import { CONFIG_TABS, nextConfigTab, problemIoMode, problemScoreSummary, type ConfigTab } from "../features/problem-config/modal-navigation.js";
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

const focusStyle = "focus-visible:outline-2 focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400 focus-visible:outline-offset-2";

export default function ProblemConfigModal({ problemName, testPath, initialConfig, hasScoredResults = false, onSave, onClose, customCheckers = [], interactors = [], saveDisabled = false }: Props) {
  const { t } = useTranslation();
  const editor = useProblemConfigEditor({ problemName, testPath, initialConfig, onSave, onClose });
  const [activeTab, setActiveTab] = useState<ConfigTab>("basic");
  const [showContent, setShowContent] = useState(false);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [popoverInput, setPopoverInput] = useState("");
  const [batchPointsTotal, setBatchPointsTotal] = useState("");
  const [confirmingSave, setConfirmingSave] = useState(false);
  const [compileConfigValid, setCompileConfigValid] = useState(true);
  const [quickSelection, setQuickSelection] = useState("");
  const [quickGroupName, setQuickGroupName] = useState("");
  const [quickGroupError, setQuickGroupError] = useState("");
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<ConfigTab, HTMLButtonElement>>>({});
  const nestedReturnRef = useRef<HTMLElement | null>(null);
  const id = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The menu item that opens this modal is removed; retain the scoreboard trigger.
    const triggerLabel = t("scoreboard.actionsFor", { name: problemName });
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
      .find((button) => button.getAttribute("aria-label") === triggerLabel);
    tabRefs.current.basic?.focus();
    return () => {
      const target = previous?.isConnected && previous.tabIndex >= 0 ? previous : trigger;
      if (target?.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    if (!confirmingSave && !popover && editingGroup === null) return;
    const target = nestedReturnRef.current;
    if (confirmingSave) rootRef.current?.querySelector<HTMLElement>('[role="alertdialog"] button')?.focus();
    return () => {
      if (target?.isConnected && target.getClientRects().length) target.focus();
    };
  }, [confirmingSave, popover, editingGroup]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const visibleDialogs = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
        .filter((dialog) => dialog.getClientRects().length > 0);
      const topDialog = visibleDialogs[visibleDialogs.length - 1];
      if (topDialog && !rootRef.current?.contains(topDialog)) return;
      if (event.key === "Escape") {
        if (
          topDialog?.dataset.nestedModal
          || rootRef.current?.querySelector("[data-nested-modal]")
        ) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (confirmingSave) setConfirmingSave(false);
        else if (editingGroup !== null) setEditingGroup(null);
        else if (popover) setPopover(null);
        else onClose();
      } else if (event.key === "Tab") {
        const dialogs = rootRef.current?.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]');
        const scope = dialogs?.[dialogs.length - 1];
        const controls: HTMLElement[] = scope ? [...scope.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
          .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0) : [];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); scope?.focus(); return; }
        if (!scope?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [confirmingSave, editingGroup, onClose, popover]);

  const handleTabChange = (tab: ConfigTab) => {
    if (tab !== activeTab) setPopover(null);
    setActiveTab(tab);
  };
  const closePopover = () => setPopover(null);
  const savePopover = () => {
    if (!popover) return;
    editor.applyEdit(popover, popoverInput);
    closePopover();
  };
  const requestSave = () => {
    if (editor.isSaving || saveDisabled || !compileConfigValid) return;
    if (hasScoredResults) {
      nestedReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmingSave(true);
    } else void editor.save();
  };
  const showCompileError = () => {
    handleTabChange("compile");
    requestAnimationFrame(() => {
      const invalid = rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      (invalid ?? tabRefs.current.compile)?.focus();
    });
  };
  const io = problemIoMode(editor.config.isInteractive ?? false, editor.useStdIn, editor.useStdOut);
  const applyQuickGroup = () => {
    try {
      const indices = parseTestSelection(quickSelection, editor.testDetails.length);
      if (indices.length === 0) throw new Error(t("problemConfig.quickGroup.invalid"));
      editor.assignGroup(indices.map(index => editor.testDetails[index - 1].name), quickGroupName);
      setQuickSelection("");
      setQuickGroupError("");
    } catch {
      setQuickGroupError(t("problemConfig.quickGroup.invalid"));
    }
  };

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 dark:bg-black/80 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-6xl flex-col rounded-md border border-surface-border bg-surface shadow-sm"
        onClick={() => popover && closePopover()}>
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-surface-border bg-surface-elevated p-4 rounded-t-md">
          <div className="min-w-0">
            <h3 id={`${id}-title`} className="break-words text-sm font-semibold text-text-primary">{t("problemConfig.title")}: {problemName}</h3>
            <div className="mt-1 font-mono tabular-nums text-xs text-text-muted" aria-live="polite">
              {editor.isLoading ? t("problemConfig.summaryLoading") : editor.loadError ? t("problemConfig.summaryUnavailable") : t("problemConfig.summary", {
                count: editor.testDetails.length,
                points: problemScoreSummary(editor.config.totalScore, editor.totalPoints),
                io: t(`problemConfig.ioModes.${io}`),
              })}
            </div>
          </div>
          <button type="button" onClick={onClose} className={`flex-none rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary ${focusStyle}`} aria-label={t("problemConfig.close")}><X className="h-5 w-5" /></button>
        </div>
        <div role="tablist" aria-label={t("problemConfig.title")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-surface-border bg-surface-elevated px-4 select-none">
          {CONFIG_TABS.map((tab) => (
            <button key={tab} type="button" role="tab" id={`${id}-tab-${tab}`} aria-controls={`${id}-panel-${tab}`}
              aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1}
              ref={(element) => { if (element) tabRefs.current[tab] = element; }}
              onClick={() => handleTabChange(tab)}
              onKeyDown={(event) => {
                const next = nextConfigTab(tab, event.key);
                if (next) { event.preventDefault(); handleTabChange(next); tabRefs.current[next]?.focus(); }
              }}
              className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-xs cursor-pointer ${focusStyle} focus-visible:outline-offset-[-3px] ${activeTab === tab ? "border-[#285f54] font-semibold text-[#285f54] dark:border-emerald-400 dark:text-emerald-400" : "border-transparent font-medium text-text-muted hover:text-text-primary"}`}>
              {t(`problemConfig.tabs.${tab}`)}
            </button>
          ))}
        </div>
        {(editor.loadError || saveDisabled) && <div className="shrink-0 space-y-2 px-4 pt-3">
          {editor.loadError && <div role="alert" className="flex items-center gap-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"><AlertCircle className="h-4 w-4 flex-none" />{editor.loadError}</div>}
          {saveDisabled && <div role="status" className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"><AlertCircle className="h-4 w-4 flex-none" />{t("problemConfig.readOnlyWhileBusy")}</div>}
        </div>}
        <div ref={bodyScrollRef} className="min-h-0 flex-1 overflow-y-auto p-5 text-xs">
          {/* Keep panels mounted: invalid compile drafts and child state survive tab changes. */}
          <div role="tabpanel" id={`${id}-panel-basic`} aria-labelledby={`${id}-tab-basic`} className={activeTab === "basic" ? "space-y-4" : "hidden"}>
            <BasicProblemSettings problemName={problemName} config={editor.config} setConfig={editor.setConfig} customCheckers={customCheckers} interactors={interactors}
              useStdIn={editor.useStdIn} setUseStdIn={editor.setUseStdIn} useStdOut={editor.useStdOut} setUseStdOut={editor.setUseStdOut}
              inputFile={editor.inputFile} setInputFile={editor.setInputFile} outputFile={editor.outputFile} setOutputFile={editor.setOutputFile} setTotalScore={editor.setTotalScore} />
          </div>
          <div role="tabpanel" id={`${id}-panel-tests`} aria-labelledby={`${id}-tab-tests`} className={activeTab === "tests" ? "space-y-4" : "hidden"}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <label className="flex cursor-pointer select-none items-center gap-2 font-medium text-text-primary"><input type="checkbox" checked={editor.config.testWellFormed ?? false}
                onChange={(event) => {
                  const checked = event.target.checked;
                  editor.setConfig(previous => ({ ...previous, testWellFormed: checked }));
                }}
                className={`h-4 w-4 accent-[#285f54] dark:accent-emerald-400 ${focusStyle}`} />{t("problemConfig.testWellFormed")}</label>
              <label className="flex cursor-pointer select-none items-center gap-2 font-medium text-text-primary"><input type="checkbox" checked={editor.polygonConfig.enableGroups}
                onChange={(event) => editor.setPolygonConfig((previous) => ({ ...previous, enableGroups: event.target.checked }))}
                className={`h-4 w-4 accent-[#285f54] dark:accent-emerald-400 ${focusStyle}`} />{t("problemConfig.enableGroups")}</label>
              <label className="flex cursor-pointer select-none items-center gap-2 font-medium text-text-primary"><input type="checkbox" checked={showContent} onChange={(event) => setShowContent(event.target.checked)}
                className={`h-4 w-4 accent-[#285f54] dark:accent-emerald-400 ${focusStyle}`} />{t("problemConfig.showContent")}</label>
            </div>
            {editor.config.testWellFormed && <div className="rounded border border-surface-border bg-surface-elevated px-3 py-2 text-text-muted">
              <p>{t("problemConfig.wellFormedHint")}</p>
              {editor.wellFormedChecking && <p role="status" className="mt-1">{t("problemConfig.wellFormedChecking")}</p>}
              {!editor.wellFormedChecking && editor.wellFormedIssues.length > 0 && <div role="alert" className="mt-2 max-h-32 overflow-y-auto text-rose-700 dark:text-rose-300">
                {editor.wellFormedIssues.slice(0, 10).map((issue, index) => <p key={`${issue.testName}-${issue.line}-${issue.column}-${index}`}>
                  {t("problemConfig.wellFormedIssue", { file: issue.fileName, test: issue.testName, line: issue.line, column: issue.column, reason: t(`problemConfig.wellFormedReasons.${issue.code}`) })}
                </p>)}
                {editor.wellFormedIssues.length > 10 && <p>+{editor.wellFormedIssues.length - 10}</p>}
              </div>}
              {editor.wellFormedChecked && !editor.wellFormedChecking && editor.wellFormedIssues.length === 0 && <p className="mt-1 text-[#285f54] dark:text-emerald-400">{t("problemConfig.wellFormedPassed")}</p>}
            </div>}
            {editor.polygonConfig.enableGroups && <div className="rounded border border-surface-border bg-surface-elevated p-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[14rem] flex-[2] space-y-1 font-medium text-text-primary"><span>{t("problemConfig.quickGroup.selection")}</span>
                  <input value={quickSelection} onChange={event => { setQuickSelection(event.target.value); setQuickGroupError(""); }} placeholder={t("problemConfig.quickGroup.example")}
                    className="w-full rounded border border-surface-border-strong bg-input-bg px-3 py-2 font-mono text-text-primary focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400" /></label>
                <label className="min-w-[9rem] flex-1 space-y-1 font-medium text-text-primary"><span>{t("problemConfig.quickGroup.groupName")}</span>
                  <input value={quickGroupName} onChange={event => setQuickGroupName(event.target.value)}
                    className="w-full rounded border border-surface-border-strong bg-input-bg px-3 py-2 text-text-primary focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400" /></label>
                <button type="button" onClick={applyQuickGroup} className="rounded bg-[#285f54] px-4 py-2 font-semibold text-white hover:bg-[#204d44] focus-visible:outline-2 focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400">{t("problemConfig.quickGroup.apply")}</button>
              </div>
              <p className="mt-2 text-text-muted">{t("problemConfig.quickGroup.hint")}</p>
              {quickGroupError && <p role="alert" className="mt-1 text-rose-700 dark:text-rose-300">{quickGroupError}</p>}
            </div>}
            <TestConfigurationTable config={editor.polygonConfig} defaultTimeLimit={editor.config.timeLimit} tests={editor.testDetails} selectedTests={editor.selectedTests} showContent={showContent} isLoading={editor.isLoading} totalPoints={editor.totalPoints}
              onToggleAll={editor.toggleAllTests} onToggleTest={editor.toggleTest} onOpenEdit={(nextPopover, input, batchTotal) => {
                nestedReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                setPopover(nextPopover); setPopoverInput(input); if (batchTotal !== undefined) setBatchPointsTotal(batchTotal);
              }} />
            <GroupPolicyTable config={editor.polygonConfig} tests={editor.testDetails} onConfigChange={editor.setPolygonConfig} onAddDependency={editor.addDependency} onRemoveDependency={editor.removeDependency}
              onEditGroup={(name) => { nestedReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setEditingGroup(name); }} />
          </div>
          <div role="tabpanel" id={`${id}-panel-compile`} aria-labelledby={`${id}-tab-compile`} className={activeTab === "compile" ? "space-y-4" : "hidden"}>
            <CompileProblemSettings value={editor.config.compile} onChange={(compile) => editor.setConfig((previous) => withProblemCompileConfig(previous, compile))} onValidityChange={setCompileConfigValid} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 rounded-b-md border-t border-surface-border bg-surface-elevated p-4">
          {(editor.saveError || !compileConfigValid) && <div className="mr-auto space-y-1 text-xs text-rose-700 dark:text-rose-300">
            {editor.saveError && <div role="alert">{editor.saveError}</div>}
            {!compileConfigValid && <div role="status">{t("problemConfig.compile.saveBlocked")}{" "}<button type="button" onClick={showCompileError} className={`rounded underline ${focusStyle}`}>{t("problemConfig.reviewCompile")}</button></div>}
          </div>}
          <button type="button" onClick={onClose} className={`select-none rounded border border-surface-border bg-surface px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover ${focusStyle}`}>{t("problemConfig.cancel")}</button>
          <button type="button" disabled={editor.isSaving || saveDisabled || !compileConfigValid} onClick={requestSave}
            className={`select-none rounded bg-[#285f54] px-5 py-2 text-xs font-semibold text-white hover:bg-[#204d44] dark:bg-emerald-800 dark:hover:bg-emerald-700 disabled:opacity-50 ${focusStyle}`}>
            {editor.isSaving ? t("problemConfig.saving") : t("problemConfig.save")}
          </button>
        </div>
        {popover && <TestEditPopover popover={popover} input={popoverInput} batchPointsTotal={batchPointsTotal} selectedCount={editor.selectedTests.size} onInputChange={setPopoverInput} onBatchPointsTotalChange={setBatchPointsTotal} onCancel={closePopover} onSave={savePopover} />}
        {editingGroup !== null && <GroupEditDialog groupName={editingGroup} config={editor.polygonConfig} tests={editor.testDetails}
          onApply={(names, total) => { editor.editGroup(editingGroup, names, total); setEditingGroup(null); }} onCancel={() => setEditingGroup(null)}
          onWheelBehind={(deltaY) => bodyScrollRef.current?.scrollBy({ top: deltaY })} />}
      </div>
      {confirmingSave && <ProblemConfigSaveConfirmDialog disabled={editor.isSaving || saveDisabled || !compileConfigValid} problemName={problemName} onCancel={() => setConfirmingSave(false)} onConfirm={() => {
        setConfirmingSave(false); void editor.save();
      }} />}
    </div>
  );
}
