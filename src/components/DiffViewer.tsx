import React from "react";

interface DiffViewerProps {
  expected: string;
  actual: string;
}

export default function DiffViewer({ expected, actual }: DiffViewerProps) {
  const sanitize = (str: string) => str.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
  
  const expectedLines = sanitize(expected).split("\n");
  const actualLines = sanitize(actual).split("\n");
  const maxLines = Math.max(expectedLines.length, actualLines.length);

  return (
    <div id="diff-viewer" className="mt-2 border border-zinc-800 rounded-lg overflow-hidden text-sm font-mono bg-zinc-950">
      <div className="grid grid-cols-2 bg-zinc-900 border-b border-zinc-800 text-xs font-semibold text-zinc-300 px-3 py-2">
        <div>Expected Output</div>
        <div>Actual Output</div>
      </div>
      <div className="divide-y divide-zinc-900/50 max-h-96 overflow-y-auto bg-zinc-950">
        {Array.from({ length: maxLines }).map((_, idx) => {
          const expLine = idx < expectedLines.length ? expectedLines[idx] : null;
          const actLine = idx < actualLines.length ? actualLines[idx] : null;

          // Standardized trimming for exact comparison matches
          const isMatch = expLine !== null && actLine !== null && expLine.trim() === actLine.trim();

          return (
            <div key={idx} className="grid grid-cols-2 text-xs leading-5 divide-x divide-zinc-900/50">
              {/* Expected column */}
              <div
                className={`p-2 whitespace-pre ${
                  isMatch
                    ? "bg-zinc-950 text-zinc-400/80"
                    : expLine === null
                    ? "bg-zinc-900/10 text-zinc-600 italic"
                    : "bg-emerald-950/30 text-emerald-400 border-l-2 border-emerald-600 font-medium"
                }`}
              >
                <span className="select-none text-zinc-600 mr-2 text-[10px]">{idx + 1}</span>
                {expLine === null ? "[no line]" : expLine || " "}
              </div>

              {/* Actual column */}
              <div
                className={`p-2 whitespace-pre ${
                  isMatch
                    ? "bg-zinc-950 text-zinc-400/80"
                    : actLine === null
                    ? "bg-zinc-900/10 text-zinc-600 italic"
                    : "bg-rose-950/35 text-rose-400 border-l-2 border-rose-600 font-medium"
                }`}
              >
                <span className="select-none text-zinc-600 mr-2 text-[10px]">{idx + 1}</span>
                {actLine === null ? "[no line]" : actLine || " "}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
