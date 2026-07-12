import React, { useState, useMemo } from "react";
import { X, CheckCircle2, XCircle, AlertTriangle, Clock, AlertCircle } from "lucide-react";
import { ProblemResult } from "../types";

interface Props {
  data: ProblemResult;
  contestantName: string;
  onClose: () => void;
}

export default function JudgingDetailsModal({ data, contestantName, onClose }: Props) {
  const [filter, setFilter] = useState<"ALL" | "CORRECT" | "INCORRECT" | "PARTIAL">("ALL");

  const getStatusDisplay = (st: string) => {
    switch (st) {
      case "AC": return { col: "text-emerald-400", el: <CheckCircle2 className="w-3.5 h-3.5" /> };
      case "WA": return { col: "text-rose-400", el: <XCircle className="w-3.5 h-3.5" /> };
      case "PE": return { col: "text-blue-400", el: <XCircle className="w-3.5 h-3.5" /> };
      case "TLE": return { col: "text-amber-400", el: <Clock className="w-3.5 h-3.5" /> };
      case "MLE": return { col: "text-amber-500", el: <AlertTriangle className="w-3.5 h-3.5" /> };
      case "RE": return { col: "text-slate-400", el: <AlertTriangle className="w-3.5 h-3.5" /> };
      case "CE": return { col: "text-violet-400", el: <AlertTriangle className="w-3.5 h-3.5" /> };
      default: return { col: "text-zinc-500", el: <AlertCircle className="w-3.5 h-3.5" /> };
    }
  };

  const filteredTests = useMemo(() => {
    return data.testCases.filter(tc => {
      if (filter === "ALL") return true;
      if (filter === "CORRECT") return tc.status === "AC";
      if (filter === "INCORRECT") return tc.status !== "AC" && tc.status !== "PE"; // usually PE is partial or wrong. Let's group all non-AC.
      if (filter === "PARTIAL") return tc.status === "PE";
      return true;
    });
  }, [data.testCases, filter]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#0f0f11] border border-zinc-800 rounded-lg w-full max-w-4xl shadow-2xl flex flex-col max-h-[95vh]">
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
           <div className="flex flex-col">
             <h3 className="text-zinc-200 font-bold tracking-wider uppercase text-[11px]">
               Judging Details: <span className="text-indigo-400">{contestantName}</span>
             </h3>
             <span className="text-zinc-500 text-2xs font-mono mt-0.5">Problem: {data.problemName} | Overall: {data.summary.status} | Score: {data.summary.score}/{data.summary.maxScore}</span>
           </div>
           <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
             <X className="w-5 h-5" />
           </button>
        </div>

        <div className="p-0 flex-1 overflow-y-auto flex flex-col font-sans text-xs">
          {/* Compilation section */}
          {data.compileStatus === "CE" ? (
             <div className="bg-violet-950/20 p-5 border-b border-zinc-800/80">
                <h4 className="flex items-center gap-2 text-violet-400 font-bold uppercase tracking-widest text-[10px] mb-2">
                  <AlertTriangle className="w-4 h-4" /> Compilation Failure
                </h4>
                <pre className="font-mono text-2xs text-violet-300 whitespace-pre-wrap overflow-x-auto">{data.compileError}</pre>
             </div>
          ) : (
             <div className="bg-[#121214] p-4 flex items-center justify-between border-b border-zinc-800/80">
                <div className="flex gap-2 items-center text-zinc-400 text-2xs">
                   <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                   <span>Compiled successfully in {data.compileTime?.toFixed(2)}ms</span>
                </div>
                
                <div className="flex border border-zinc-800 rounded bg-[#0a0a0c] p-0.5 mt-2 sm:mt-0">
                  {["ALL", "CORRECT", "INCORRECT", "PARTIAL"].map(f => (
                    <button 
                      key={f}
                      onClick={() => setFilter(f as any)}
                      className={`text-2xs font-semibold px-3 py-1 rounded transition ${filter === f ? "bg-zinc-800 text-zinc-200 shadow" : "text-zinc-500 hover:text-zinc-400"}`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
             </div>
          )}

          {/* Test cases list */}
          <div className="divide-y divide-zinc-800/50 bg-[#0a0a0c]">
            {filteredTests.map((tc, idx) => {
              const dspl = getStatusDisplay(tc.status);
              return (
                 <div key={idx} className="p-4 hover:bg-zinc-900/40 transition flex flex-col">
                    <div className="flex items-center justify-between mb-2">
                       <span className="font-mono font-bold text-zinc-300 text-[11px]">{tc.name}</span>
                       <div className="flex items-center gap-4">
                          <span className="font-mono text-zinc-500 text-2xs">{((tc.executionTime)/1000).toFixed(4)}s</span>
                          {tc.peakMemory !== undefined && (
                             <span className="font-mono text-zinc-500 text-2xs">{(tc.peakMemory / 1024).toFixed(2)} MB</span>
                          )}
                          <span className="text-zinc-400 font-bold text-[10px]">Score: {Number(tc.score).toFixed(4).replace(/\.?0+$/, '')}</span>
                          <div className={`flex items-center gap-1.5 font-bold text-[10px] uppercase tracking-wider w-24 ${dspl.col}`}>
                            {dspl.el} {tc.status}
                          </div>
                       </div>
                    </div>
                    {tc.checkerMessage && (
                       <div className="bg-indigo-950/10 border border-indigo-900/30 p-2 rounded mt-1.5 text-2xs font-mono text-indigo-300">
                          <strong>Checker:</strong> {tc.checkerMessage}
                       </div>
                    )}
                    {(tc.status === "WA" || tc.status === "PE") && (
                       <div className="grid grid-cols-2 gap-3 mt-2">
                          <div className="bg-[#050505] border border-zinc-800 p-2 rounded font-mono text-2xs text-zinc-400 overflow-x-auto max-h-32 whitespace-pre-wrap">
                            <span className="block font-bold text-zinc-600 mb-1 border-b border-zinc-800 pb-1">Expected Output</span>
                            {tc.expectedOutputPreview || "[No Output]"}
                          </div>
                          <div className="bg-[#050505] border border-zinc-800 p-2 rounded font-mono text-2xs text-rose-300 overflow-x-auto max-h-32 whitespace-pre-wrap">
                            <span className="block font-bold text-rose-900/60 mb-1 border-b border-zinc-800 pb-1">Contestant Output</span>
                            {tc.actualOutputPreview || "[No Output]"}
                          </div>
                       </div>
                    )}
                    {tc.errorDetail && tc.status !== "WA" && (
                       <div className="bg-rose-950/20 text-rose-400 border border-rose-900/40 p-2 text-2xs font-mono rounded mt-2">
                         {tc.errorDetail}
                       </div>
                    )}
                 </div>
              );
            })}
            
            {filteredTests.length === 0 && data.compileStatus !== "CE" && (
               <div className="text-center py-12 text-zinc-500 text-xs font-mono">
                 No testcases match the current filter.
               </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
