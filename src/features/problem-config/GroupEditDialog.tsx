import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PolygonConfig } from "../../types";
import { addRational, createRational, divideRational, formatRational, multiplyRational, parseRational } from "../../../shared/rational";
import { parseNonNegativePointInput, type TestDetail } from "./editor-state";
import { formatTestSelection, parseTestSelection } from "./test-selection";

interface Props {
  groupName: string;
  config: PolygonConfig;
  tests: readonly TestDetail[];
  onApply: (names: string[], total?: string) => void;
  onCancel: () => void;
  onWheelBehind: (deltaY: number) => void;
}

export function GroupEditDialog({ groupName, config, tests, onApply, onCancel, onWheelBehind }: Props) {
  const { t } = useTranslation();
  const initialIndices = tests.flatMap((test, index) => config.tests[test.name]?.group === groupName ? [index + 1] : []);
  const initialPoints = initialIndices.map(index => parseRational(config.tests[tests[index - 1].name]?.points ?? 1));
  const initialTotal = formatRational(initialPoints.reduce(addRational, createRational(0)));
  const uniform = initialPoints.every(point => point.n === initialPoints[0]?.n && point.d === initialPoints[0]?.d);
  const [selection, setSelection] = useState(formatTestSelection(initialIndices));
  const [total, setTotal] = useState(initialTotal);
  const [each, setEach] = useState(uniform && initialPoints.length ? formatRational(initialPoints[0]) : "");
  const [editedScore, setEditedScore] = useState<"total" | "each" | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const updateSelection = (value: string) => {
    setSelection(value);
    setError("");
    try {
      const indices = parseTestSelection(value, tests.length);
      if (editedScore === "each" && each.trim()) {
        setTotal(formatRational(multiplyRational(parseNonNegativePointInput(each), createRational(indices.length))));
      } else if (editedScore === "total" && total.trim() && indices.length) {
        setEach(formatRational(divideRational(parseNonNegativePointInput(total), createRational(indices.length))));
      } else if (editedScore === null) {
        const points = indices.reduce((sum, index) => addRational(sum, parseRational(config.tests[tests[index - 1].name]?.points ?? 1)), createRational(0));
        setTotal(formatRational(points));
        const first = indices.length ? parseRational(config.tests[tests[indices[0] - 1].name]?.points ?? 1) : null;
        setEach(first && indices.every(index => {
          const point = parseRational(config.tests[tests[index - 1].name]?.points ?? 1);
          return point.n === first.n && point.d === first.d;
        }) ? formatRational(first) : "");
      }
    } catch { /* Keep the draft so it can be corrected. */ }
  };

  const updateTotal = (value: string) => {
    setTotal(value);
    setEditedScore("total");
    setError("");
    try {
      const count = parseTestSelection(selection, tests.length).length;
      setEach(count ? formatRational(divideRational(parseNonNegativePointInput(value), createRational(count))) : "");
    } catch { setEach(""); }
  };

  const updateEach = (value: string) => {
    setEach(value);
    setEditedScore("each");
    setError("");
    try {
      const count = parseTestSelection(selection, tests.length).length;
      setTotal(formatRational(multiplyRational(parseNonNegativePointInput(value), createRational(count))));
    } catch { setTotal(""); }
  };

  const apply = () => {
    try {
      const indices = parseTestSelection(selection, tests.length);
      const names = indices.map(index => tests[index - 1].name);
      let nextTotal: string | undefined;
      if (editedScore === "total") nextTotal = formatRational(parseNonNegativePointInput(total));
      if (editedScore === "each") nextTotal = formatRational(multiplyRational(parseNonNegativePointInput(each), createRational(names.length)));
      onApply(names, nextTotal);
    } catch {
      setError(t("problemConfig.groupEdit.invalid"));
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onWheel={event => onWheelBehind(event.deltaY)}
      onMouseDown={event => { if (event.target === event.currentTarget) event.preventDefault(); }}>
      <div role="dialog" aria-modal="true" aria-label={t("problemConfig.groupEdit.title", { name: groupName })} tabIndex={-1}
        onWheel={event => event.stopPropagation()}
        className="w-full max-w-lg rounded-md border border-surface-border-strong bg-surface p-5 text-xs text-text-primary shadow-lg">
        <h4 className="text-sm font-semibold">{t("problemConfig.groupEdit.title", { name: groupName })}</h4>
        <p className="mt-1 text-text-muted">{t("problemConfig.groupEdit.description")}</p>
        <div className="mt-4 space-y-3">
          <label className="block space-y-1 font-medium">
            <span>{t("problemConfig.quickGroup.selection")}</span>
            <input ref={inputRef} value={selection} onChange={event => updateSelection(event.target.value)}
              placeholder="1-8, 10, 12-19" className="w-full rounded border border-surface-border-strong bg-input-bg px-3 py-2 font-mono text-text-primary focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1 font-medium"><span>{t("problemConfig.groupEdit.total")}</span>
              <input value={total} onChange={event => updateTotal(event.target.value)} className="w-full rounded border border-surface-border-strong bg-input-bg px-3 py-2 font-mono text-text-primary focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400" /></label>
            <label className="block space-y-1 font-medium"><span>{t("problemConfig.groupEdit.each")}</span>
              <input value={each} onChange={event => updateEach(event.target.value)} placeholder={uniform ? "0" : t("problemConfig.groupEdit.mixed")}
                className="w-full rounded border border-surface-border-strong bg-input-bg px-3 py-2 font-mono text-text-primary focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400" /></label>
          </div>
        </div>
        {error && <p role="alert" className="mt-3 text-rose-700 dark:text-rose-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded border border-surface-border px-3 py-2 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400">{t("problemConfig.cancel")}</button>
          <button type="button" onClick={apply} className="rounded bg-[#285f54] px-4 py-2 font-semibold text-white hover:bg-[#204d44] focus-visible:outline-2 focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400">{t("problemConfig.quickGroup.apply")}</button>
        </div>
      </div>
    </div>
  );
}
