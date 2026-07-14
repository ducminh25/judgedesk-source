import React from "react";
import { useTranslation } from "react-i18next";

interface DiffViewerProps {
  expected: string;
  actual: string;
}

export default function DiffViewer({ expected, actual }: DiffViewerProps) {
  const { t } = useTranslation();
  const sanitize = (str: string) =>
    str.replace(/\r\n/g, "\n").replace(/\s+$/g, "");

  const expectedLines = sanitize(expected).split("\n");
  const actualLines = sanitize(actual).split("\n");
  const maxLines = Math.max(expectedLines.length, actualLines.length);

  return (
    <div
      id="diff-viewer"
      className="mt-2 overflow-hidden rounded-lg border border-surface-border bg-input-bg font-mono text-sm"
    >
      <div className="grid grid-cols-2 border-b border-surface-border bg-surface-elevated px-3 py-2 text-xs font-semibold text-text-primary">
        <div>{t("diff.expected")}</div>
        <div>{t("diff.actual")}</div>
      </div>
      <div className="max-h-96 divide-y divide-surface-border overflow-y-auto bg-input-bg">
        {Array.from({ length: maxLines }).map((_, idx) => {
          const expLine =
            idx < expectedLines.length ? expectedLines[idx] : null;
          const actLine = idx < actualLines.length ? actualLines[idx] : null;

          // Standardized trimming for exact comparison matches
          const isMatch =
            expLine !== null &&
            actLine !== null &&
            expLine.trim() === actLine.trim();

          return (
            <div
              key={idx}
              className="grid grid-cols-2 divide-x divide-surface-border text-xs leading-5"
            >
              {/* Expected column */}
              <div
                className={`p-2 whitespace-pre ${
                  isMatch
                    ? "bg-input-bg text-text-muted"
                    : expLine === null
                      ? "bg-surface-hover text-text-muted italic"
                      : "border-l-2 border-emerald-600 bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                }`}
              >
                <span className="mr-2 select-none text-[10px] text-text-muted">
                  {idx + 1}
                </span>
                {expLine === null ? t("diff.noLine") : expLine || " "}
              </div>

              {/* Actual column */}
              <div
                className={`p-2 whitespace-pre ${
                  isMatch
                    ? "bg-input-bg text-text-muted"
                    : actLine === null
                      ? "bg-surface-hover text-text-muted italic"
                      : "border-l-2 border-rose-600 bg-rose-50 font-medium text-rose-700 dark:bg-rose-950/35 dark:text-rose-400"
                }`}
              >
                <span className="mr-2 select-none text-[10px] text-text-muted">
                  {idx + 1}
                </span>
                {actLine === null ? t("diff.noLine") : actLine || " "}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
