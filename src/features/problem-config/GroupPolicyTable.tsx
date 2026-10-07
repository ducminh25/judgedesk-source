import { Layout, X } from "lucide-react";
import { PolygonConfig } from "../../types";
import type { TestDetail } from "./editor-state";
import { useTranslation } from "react-i18next";
import {
  addRational,
  createRational,
  formatRational,
  parseRational,
} from "../../../shared/rational";

interface Props {
  config: PolygonConfig;
  tests: readonly TestDetail[];
  onConfigChange: (config: PolygonConfig) => void;
  onAddDependency: (groupName: string, dependency: string) => void;
  onRemoveDependency: (groupName: string, dependency: string) => void;
  onEditGroup: (groupName: string) => void;
}

export function GroupPolicyTable({ config, tests: visibleTests, onConfigChange, onAddDependency, onRemoveDependency, onEditGroup }: Props) {
  const { t } = useTranslation();
  if (!config.enableGroups) return null;
  const groupNames = Object.keys(config.groups).sort();

  return (
    <div className="mt-8">
      <h4 className="text-[11px] font-bold text-text-muted uppercase tracking-widest mb-3 flex items-center gap-2">
        <Layout className="w-4 h-4" /> {t("problemConfig.groupPolicy.title")}
      </h4>
      <div className="border border-surface-border rounded-lg overflow-x-auto bg-surface-elevated">
        <table className="w-full min-w-[680px] text-left border-collapse">
          <thead>
            <tr className="bg-surface text-[10px] uppercase tracking-wider text-text-muted border-b border-surface-border">
              <th className="p-3 w-32">{t("problemConfig.groupPolicy.name")}</th>
              <th className="p-3 w-20 text-center">{t("problemConfig.groupPolicy.tests")}</th>
              <th className="p-3 w-24 text-center">{t("problemConfig.groupPolicy.points")}</th>
              <th className="p-3 w-48">{t("problemConfig.groupPolicy.policy")}</th>
              <th className="p-3">{t("problemConfig.groupPolicy.dependencies")}</th>
              <th className="p-3 text-right">{t("problemConfig.testConfig.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {groupNames.length === 0 ? (
              <tr><td colSpan={6} className="p-6 text-center text-text-muted">{t("problemConfig.groupPolicy.noGroups")}</td></tr>
            ) : groupNames.map(groupName => {
              const group = config.groups[groupName];
              const tests = visibleTests.flatMap(test => config.tests[test.name]?.group === groupName ? [config.tests[test.name]] : []);
              const pointsRat = tests.reduce((total, test) => addRational(total, parseRational(test.points)), createRational(0));
              const points = formatRational(pointsRat);
              return (
                <tr key={groupName} className="border-b border-surface-border">
                  <td className="p-3 font-bold text-indigo-600 dark:text-indigo-400">{groupName}</td>
                  <td className="p-3 text-center text-text-primary font-mono">{tests.length}</td>
                  <td className="p-3 text-center text-emerald-700 dark:text-emerald-400 font-mono">{points}</td>
                  <td className="p-3">
                    <select
                      value={group.policy}
                      onChange={event => onConfigChange({
                        ...config,
                        groups: { ...config.groups, [groupName]: { ...group, policy: event.target.value as "EACH_TEST" | "COMPLETE_GROUP" } }
                      })}
                      className="bg-input-bg border border-surface-border-strong rounded px-2 py-1.5 text-text-primary text-xs w-full"
                    >
                      <option value="EACH_TEST">EACH_TEST</option>
                      <option value="COMPLETE_GROUP">COMPLETE_GROUP</option>
                    </select>
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-2 items-center">
                      {group.dependencies.map(dependency => (
                        <span key={dependency} className="flex items-center gap-1 bg-surface-hover text-text-primary px-2 py-0.5 rounded text-2xs font-bold">
                          {dependency}
                          <button onClick={() => onRemoveDependency(groupName, dependency)} aria-label={`Remove ${dependency}`}>
                            <X className="w-3 h-3 text-text-muted hover:text-rose-500 dark:hover:text-rose-400" />
                          </button>
                        </span>
                      ))}
                      <select
                        value=""
                        onChange={event => event.target.value && onAddDependency(groupName, event.target.value)}
                        className="bg-transparent border border-surface-border-strong rounded px-1 py-0.5 text-text-muted text-2xs w-24"
                      >
                        <option value="">{t("problemConfig.groupPolicy.add")}</option>
                        {groupNames.filter(name => name !== groupName && !group.dependencies.includes(name)).map(name => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="p-3 text-right"><button type="button" onClick={() => onEditGroup(groupName)}
                    className="rounded border border-surface-border-strong px-2.5 py-1.5 font-semibold text-text-primary hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-[#246a5d] dark:focus-visible:outline-emerald-400">{t("problemConfig.groupPolicy.edit")}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
