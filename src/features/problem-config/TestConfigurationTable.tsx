import type { MouseEvent } from "react";
import { CheckSquare, Square } from "lucide-react";
import { PolygonConfig } from "../../types";
import { formatTestSize, TestDetail, TestEditPopover, TestEditType } from "./editor-state";
import { useTranslation } from "react-i18next";
import { formatScore } from "../../../shared/rational";

interface Props {
  config: PolygonConfig;
  tests: TestDetail[];
  selectedTests: ReadonlySet<string>;
  showContent: boolean;
  isLoading: boolean;
  totalPoints: number | string;
  onToggleAll: () => void;
  onToggleTest: (name: string) => void;
  onOpenEdit: (popover: TestEditPopover, input: string, batchTotal?: string) => void;
}

export function TestConfigurationTable(props: Props) {
  const { t } = useTranslation();
  const openBatch = (event: MouseEvent<HTMLButtonElement>, type: TestEditType, input: string) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    props.onOpenEdit({ type, x: rect.left, y: rect.bottom + 8 }, input, type === "batchPoints" ? "" : undefined);
  };
  const openTest = (event: MouseEvent<HTMLButtonElement>, type: TestEditType, testName: string, input: string) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    props.onOpenEdit({ type, testName, x: rect.left - 150, y: rect.bottom + 4 }, input);
  };

  return (
    <div className="space-y-2">
      {props.selectedTests.size > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900/50 rounded-lg p-3 flex items-center justify-between z-10">
          <span className="text-indigo-700 dark:text-indigo-300 font-bold text-[10px] uppercase tracking-wider">{props.selectedTests.size} {t("problemConfig.testConfig.selected")}</span>
          <div className="flex gap-2">
            <BatchButton label={t("problemConfig.testConfig.points")} onClick={event => openBatch(event, "batchPoints", "")} />
            <BatchButton label={t("problemConfig.testConfig.timeLimit")} onClick={event => openBatch(event, "batchTime", "1.0")} />
            {props.config.enableGroups && <BatchButton label={t("problemConfig.testConfig.group")} onClick={event => openBatch(event, "batchGroup", "")} />}
          </div>
        </div>
      )}
      <div className="border border-surface-border rounded-lg overflow-x-auto bg-surface-elevated relative">
        <table className={`w-full ${props.showContent && props.config.enableGroups ? "min-w-[1100px]" : props.showContent || props.config.enableGroups ? "min-w-[950px]" : "min-w-[800px]"} text-left border-collapse`}>
          <thead>
            <tr className="bg-surface text-[10px] uppercase tracking-wider text-text-muted border-b border-surface-border">
              <th className="p-3 w-10 text-center">
                <button onClick={props.onToggleAll} className="hover:text-text-primary transition-colors">
                  {props.selectedTests.size === props.tests.length && props.tests.length > 0 ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                </button>
              </th>
              <th className="p-3 w-10 text-center">#</th>
              <th className="p-3 w-32">{t("problemConfig.testConfig.testName")}</th>
              {props.showContent && <th className="p-3">{t("problemConfig.testConfig.content")}</th>}
              <th className="p-3 w-24">{t("problemConfig.testConfig.size")}</th>
              <th className="p-3 w-28">{t("problemConfig.testConfig.timeLimit")}</th>
              {props.config.enableGroups && <th className="p-3 w-32">{t("problemConfig.testConfig.group")}</th>}
              <th className="p-3 w-24 text-right"><div>{t("problemConfig.testConfig.points")}</div><div className="text-indigo-500 dark:text-indigo-400 text-2xs normal-case">{props.totalPoints} {t("problemConfig.testConfig.total")}</div></th>
              <th className="min-w-40 p-3 text-center">{t("problemConfig.testConfig.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {props.isLoading ? (
              <tr><td colSpan={props.showContent && props.config.enableGroups ? 9 : props.showContent || props.config.enableGroups ? 8 : 7} className="p-8 text-center text-text-muted animate-pulse">{t("problemConfig.testConfig.loading")}</td></tr>
            ) : props.tests.map((test, index) => {
              const testConfig = props.config.tests[test.name] || { points: 1 };
              const timeLimit = testConfig.timeLimit !== undefined ? testConfig.timeLimit : 1.0;
              return (
                <tr key={test.name} className={`border-b border-surface-border hover:bg-surface-hover transition ${props.selectedTests.has(test.name) ? "bg-indigo-50 dark:bg-indigo-950/10" : ""}`}>
                  <td className="p-3 text-center">
                    <button onClick={() => props.onToggleTest(test.name)} className={`hover:text-text-primary transition-colors ${props.selectedTests.has(test.name) ? "text-indigo-600 dark:text-indigo-400" : "text-text-muted"}`}>
                      {props.selectedTests.has(test.name) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                    </button>
                  </td>
                  <td className="p-3 text-center font-mono tabular-nums text-text-muted">{index + 1}</td>
                  <td className="p-3 font-mono text-text-primary">{test.name}</td>
                  {props.showContent && <td className="p-3 font-mono text-text-muted text-2xs truncate max-w-[200px]" title={test.preview}>{test.preview}</td>}
                  <td className="p-3 text-text-muted text-2xs">{formatTestSize(test.size)}</td>
                  <td className="p-3 font-mono text-text-primary">{timeLimit.toFixed(3)}s</td>
                  {props.config.enableGroups && <td className="max-w-32 truncate p-3 text-indigo-600 dark:text-indigo-400 font-bold" title={testConfig.group || ""}>{testConfig.group || "-"}</td>}
                  <td className="p-3 text-right text-emerald-700 dark:text-emerald-400 font-mono font-bold">{formatScore(testConfig.points)}</td>
                  <td className="p-3 text-center">
                    <div className="flex items-center justify-center gap-2 whitespace-nowrap">
                      <EditButton label={t("problemConfig.testConfig.points")} onClick={event => openTest(event, "points", test.name, (testConfig.points ?? 1).toString())} />
                      <EditButton label={t("problemConfig.testConfig.timeLimit")} onClick={event => openTest(event, "time", test.name, testConfig.timeLimit?.toString() ?? "1.0")} />
                      {props.config.enableGroups && <EditButton label={t("problemConfig.testConfig.group")} onClick={event => openTest(event, "group", test.name, testConfig.group || "")} />}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BatchButton({ label, onClick }: { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return <button onClick={onClick} className="px-2.5 py-1 bg-indigo-600 dark:bg-indigo-900 hover:bg-indigo-700 dark:hover:bg-indigo-800 text-white rounded text-2xs font-bold uppercase tracking-wider">{label}</button>;
}

function EditButton({ label, onClick }: { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return <button onClick={onClick} className="text-text-muted hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors text-[10px] uppercase font-bold tracking-wider">{label}</button>;
}
