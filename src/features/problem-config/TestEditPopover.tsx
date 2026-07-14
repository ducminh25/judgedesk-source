import { TestEditPopover as PopoverState } from "./editor-state";
import { useTranslation } from "react-i18next";

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
  return (
    <div
      className="fixed bg-surface border border-surface-border-strong shadow-2xl rounded-md p-3 z-50 flex flex-col gap-2 w-56"
      style={{ top: popover.y, left: popover.x }}
      onClick={(event) => event.stopPropagation()}
    >
      {popover.type === "points" && (
        <NumberEditor
          label={t("problemConfig.testEdit.pointFor", {
            name: popover.testName,
          })}
          value={props.input}
          onChange={props.onInputChange}
          hint={t("problemConfig.testEdit.pointHint")}
        />
      )}
      {popover.type === "time" && (
        <NumberEditor
          label={t("problemConfig.testEdit.timeFor", {
            name: popover.testName,
          })}
          value={props.input}
          onChange={props.onInputChange}
          hint={t("problemConfig.testEdit.timeHint")}
          step="0.1"
          mono
        />
      )}
      {popover.type === "group" && (
        <TextEditor
          label={t("problemConfig.testEdit.groupFor", {
            name: popover.testName,
          })}
          value={props.input}
          onChange={props.onInputChange}
          hint={t("problemConfig.testEdit.groupHint")}
        />
      )}
      {popover.type === "batchGroup" && (
        <TextEditor
          label={t("problemConfig.testEdit.groupForTests", {
            count: props.selectedCount,
          })}
          value={props.input}
          onChange={props.onInputChange}
        />
      )}
      {popover.type === "batchTime" && (
        <NumberEditor
          label={t("problemConfig.testEdit.timeForTests", {
            count: props.selectedCount,
          })}
          value={props.input}
          onChange={props.onInputChange}
          hint={t("problemConfig.testEdit.timeHint")}
          step="0.1"
          mono
        />
      )}
      {popover.type === "batchPoints" && (
        <>
          <label className="text-2xs font-bold text-text-muted uppercase">
            {t("problemConfig.testEdit.totalPoints", {
              count: props.selectedCount,
            })}
          </label>
          <input
            type="number"
            value={props.batchPointsTotal}
            onChange={(event) => {
              props.onBatchPointsTotalChange(event.target.value);
              const total = parseFloat(event.target.value);
              if (!Number.isNaN(total) && props.selectedCount > 0)
                props.onInputChange((total / props.selectedCount).toString());
            }}
            className="bg-input-bg border border-surface-border-strong rounded px-2 py-1 text-sm text-emerald-600 dark:text-emerald-400 font-bold"
          />
          <label className="text-2xs font-bold text-text-muted uppercase mt-1">
            {t("problemConfig.testEdit.eachPoint")}
          </label>
          <input
            type="number"
            value={props.input}
            onChange={(event) => {
              props.onInputChange(event.target.value);
              const points = parseFloat(event.target.value);
              if (!Number.isNaN(points) && props.selectedCount > 0)
                props.onBatchPointsTotalChange(
                  (points * props.selectedCount).toString(),
                );
            }}
            className="bg-input-bg border border-surface-border-strong rounded px-2 py-1 text-sm text-text-primary"
          />
        </>
      )}
      <div className="flex justify-end gap-2 mt-2">
        <button
          onClick={props.onCancel}
          className="px-3 py-1 bg-surface-elevated hover:bg-surface-hover rounded text-xs text-text-primary transition-colors"
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={props.onSave}
          className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-xs text-white font-bold transition-colors"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

interface EditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}

function TextEditor({ label, value, onChange, hint }: EditorProps) {
  return (
    <>
      <label className="text-2xs font-bold text-text-muted uppercase">
        {label}
      </label>
      <input
        type="text"
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="bg-input-bg border border-surface-border-strong rounded px-2 py-1 text-sm text-text-primary"
      />
      {hint && <span className="text-[9px] text-text-muted">{hint}</span>}
    </>
  );
}

function NumberEditor({
  label,
  value,
  onChange,
  hint,
  step,
  mono,
}: EditorProps & { step?: string; mono?: boolean }) {
  return (
    <>
      <label className="text-2xs font-bold text-text-muted uppercase">
        {label}
      </label>
      <input
        type="number"
        step={step}
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`bg-input-bg border border-surface-border-strong rounded px-2 py-1 text-sm text-text-primary ${mono ? "font-mono" : ""}`}
      />
      {hint && <span className="text-[9px] text-text-muted">{hint}</span>}
    </>
  );
}
