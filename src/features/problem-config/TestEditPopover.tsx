import { type FormEvent } from "react";
import { Clock, Coins, FolderTree, X } from "lucide-react";
import { TestEditPopover as PopoverState } from "./editor-state";
import { useTranslation } from "react-i18next";
import {
  parseRational,
  formatRational,
  divideRational,
  multiplyRational,
  createRational,
} from "../../../shared/rational";

interface Props {
  popover: PopoverState;
  input: string;
  batchPointsTotal: string;
  selectedCount: number;
  onInputChange: (value: string) => void;
  onBatchPointsTotalChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}

export function TestEditPopover(props: Props) {
  const { popover } = props;
  const { t } = useTranslation();

  const handleSubmit = (event?: FormEvent) => {
    if (event) event.preventDefault();
    props.onSave();
  };

  const isPointsType = popover.type === "points" || popover.type === "batchPoints";
  const isTimeType = popover.type === "time" || popover.type === "batchTime";
  const isGroupType = popover.type === "group" || popover.type === "batchGroup";

  const getHeaderInfo = () => {
    if (popover.type === "batchPoints") {
      return {
        title: t("problemConfig.testConfig.points"),
        subtitle: t("problemConfig.testEdit.totalPoints", { count: props.selectedCount }),
        icon: Coins,
        iconColor: "text-emerald-500 bg-emerald-500/10",
      };
    }
    if (popover.type === "points") {
      return {
        title: t("problemConfig.testConfig.points"),
        subtitle: t("problemConfig.testEdit.pointFor", { name: popover.testName }),
        icon: Coins,
        iconColor: "text-emerald-500 bg-emerald-500/10",
      };
    }
    if (popover.type === "batchTime") {
      return {
        title: t("problemConfig.testConfig.timeLimit"),
        subtitle: t("problemConfig.testEdit.timeForTests", { count: props.selectedCount }),
        icon: Clock,
        iconColor: "text-indigo-500 bg-indigo-500/10",
      };
    }
    if (popover.type === "time") {
      return {
        title: t("problemConfig.testConfig.timeLimit"),
        subtitle: t("problemConfig.testEdit.timeFor", { name: popover.testName }),
        icon: Clock,
        iconColor: "text-indigo-500 bg-indigo-500/10",
      };
    }
    if (popover.type === "batchGroup") {
      return {
        title: t("problemConfig.testConfig.group"),
        subtitle: t("problemConfig.testEdit.groupForTests", { count: props.selectedCount }),
        icon: FolderTree,
        iconColor: "text-amber-500 bg-amber-500/10",
      };
    }
    return {
      title: t("problemConfig.testConfig.group"),
      subtitle: t("problemConfig.testEdit.groupFor", { name: popover.testName }),
      icon: FolderTree,
      iconColor: "text-amber-500 bg-amber-500/10",
    };
  };

  const header = getHeaderInfo();
  const HeaderIcon = header.icon;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
      onClick={props.onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={header.title}
        className="w-full max-w-sm rounded-lg border border-surface-border bg-surface shadow-lg overflow-hidden flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className={`rounded-md p-2 ${header.iconColor}`}>
              <HeaderIcon className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
                {header.title}
              </h3>
              <p className="text-2xs text-text-muted truncate max-w-[220px]" title={header.subtitle}>
                {header.subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={props.onCancel}
            aria-label={t("common.cancel")}
            className="text-text-muted hover:text-text-primary p-1 rounded transition-colors hover:bg-surface-hover"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          {popover.type === "points" && (
            <TextEditor
              label={t("problemConfig.testConfig.points")}
              value={props.input}
              onChange={props.onInputChange}
              hint={t("problemConfig.testEdit.pointHint", "Nhập số hoặc phân số (vd: 1/3, 0.5, 2)")}
              onEnter={handleSubmit}
            />
          )}

          {popover.type === "time" && (
            <NumberEditor
              label={t("problemConfig.testConfig.timeLimit")}
              value={props.input}
              onChange={props.onInputChange}
              hint={t("problemConfig.testEdit.timeHint")}
              step="0.1"
              mono
              onEnter={handleSubmit}
            />
          )}

          {popover.type === "group" && (
            <TextEditor
              label={t("problemConfig.testConfig.group")}
              value={props.input}
              onChange={props.onInputChange}
              hint={t("problemConfig.testEdit.groupHint")}
              onEnter={handleSubmit}
            />
          )}

          {popover.type === "batchGroup" && (
            <TextEditor
              label={t("problemConfig.testConfig.group")}
              value={props.input}
              onChange={props.onInputChange}
              hint={t("problemConfig.testEdit.groupHint")}
              onEnter={handleSubmit}
            />
          )}

          {popover.type === "batchTime" && (
            <NumberEditor
              label={t("problemConfig.testConfig.timeLimit")}
              value={props.input}
              onChange={props.onInputChange}
              hint={t("problemConfig.testEdit.timeHint")}
              step="0.1"
              mono
              onEnter={handleSubmit}
            />
          )}

          {popover.type === "batchPoints" && (
            <div className="space-y-3">
              <div>
                <label className="text-2xs font-bold text-text-muted uppercase block mb-1">
                  {t("problemConfig.testEdit.totalPoints", {
                    count: props.selectedCount,
                  })}
                </label>
                <input
                  type="text"
                  autoFocus
                  placeholder="vd: 2 hoặc 100/3"
                  value={props.batchPointsTotal}
                  onChange={(event) => {
                    const text = event.target.value;
                    props.onBatchPointsTotalChange(text);
                    const val = text.trim();
                    if (val && props.selectedCount > 0) {
                      const totalRat = parseRational(val);
                      const eachRat = divideRational(totalRat, createRational(props.selectedCount));
                      props.onInputChange(formatRational(eachRat));
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleSubmit();
                    }
                  }}
                  className="w-full bg-input-bg border border-surface-border-strong rounded px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400 font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="text-2xs font-bold text-text-muted uppercase block mb-1">
                  {t("problemConfig.testEdit.eachPoint")}
                </label>
                <input
                  type="text"
                  placeholder="vd: 1/3 hoặc 0.5"
                  value={props.input}
                  onChange={(event) => {
                    const text = event.target.value;
                    props.onInputChange(text);
                    const val = text.trim();
                    if (val && props.selectedCount > 0) {
                      const eachRat = parseRational(val);
                      const totalRat = multiplyRational(eachRat, createRational(props.selectedCount));
                      props.onBatchPointsTotalChange(formatRational(totalRat));
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleSubmit();
                    }
                  }}
                  className="w-full bg-input-bg border border-surface-border-strong rounded px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                />
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex justify-end gap-2 pt-2 border-t border-surface-border mt-3">
            <button
              type="button"
              onClick={props.onCancel}
              className="px-3.5 py-1.5 bg-surface-elevated hover:bg-surface-hover rounded text-xs font-semibold text-text-primary transition-colors border border-surface-border"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-xs text-white font-bold transition-colors shadow-xs"
            >
              {t("common.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface EditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  onEnter?: () => void;
}

function TextEditor({ label, value, onChange, hint, onEnter }: EditorProps) {
  return (
    <div className="space-y-1">
      <label className="text-2xs font-bold text-text-muted uppercase block">
        {label}
      </label>
      <input
        type="text"
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
        className="w-full bg-input-bg border border-surface-border-strong rounded px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      {hint && <span className="text-[10px] text-text-muted block leading-tight">{hint}</span>}
    </div>
  );
}

function NumberEditor({
  label,
  value,
  onChange,
  hint,
  step,
  mono,
  onEnter,
}: EditorProps & { step?: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <label className="text-2xs font-bold text-text-muted uppercase block">
        {label}
      </label>
      <input
        type="number"
        step={step}
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
        className={`w-full bg-input-bg border border-surface-border-strong rounded px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
          mono ? "font-mono tabular-nums" : ""
        }`}
      />
      {hint && <span className="text-[10px] text-text-muted block leading-tight">{hint}</span>}
    </div>
  );
}
