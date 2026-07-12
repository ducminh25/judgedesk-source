const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// I will just replace the damaged chunk with the intended correct chunk.
const damagedChunkRegex = /<span className="text-\[10px\] text-zinc-500 font-medium">Enterprise v2\.0\.0<\/span>[\s\S]*?<span>Contestant<\/span>\s*<\/div>\s*<\/th>/;

const correctChunk = `<span className="text-[10px] text-zinc-500 font-medium">Enterprise v2.0.0</span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-full px-6 py-6 mx-auto w-full flex flex-col lg:flex-row gap-6 relative">
        {/* Config Panel */}
        <div className="lg:w-[320px] flex-shrink-0 flex flex-col gap-6">
          <form onSubmit={handleRunJudge} className="bg-[#0f0f11] rounded-lg border border-zinc-800 overflow-hidden shadow-xl shadow-black/80 flex flex-col p-5">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-4 block">Batch Configuration</span>
            
            <div className="space-y-4 flex-1">
               <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300">Contestants Directory</label>
                  <input
                    type="text"
                    value={thisinhPath}
                    onChange={(e) => setThisinhPath(e.target.value)}
                    placeholder="/path/to/contestants"
                    className="w-full bg-[#121214] text-sm text-zinc-200 p-2.5 rounded border border-zinc-700/50 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition font-mono"
                  />
               </div>
               
               <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300 flex items-center justify-between">
                     Testcases Directory
                  </label>
                  <input
                    type="text"
                    value={testPath}
                    onChange={(e) => setTestPath(e.target.value)}
                    placeholder="/path/to/testcases"
                    className="w-full bg-[#121214] text-sm text-zinc-200 p-2.5 rounded border border-zinc-700/50 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition font-mono"
                  />
               </div>

               <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                     <Timer className="w-3.5 h-3.5" /> Time Limit (ms)
                  </label>
                  <input
                    type="number"
                    value={timeLimit}
                    onChange={(e) => setTimeLimit(e.target.value)}
                    placeholder="1000"
                    className="w-full bg-[#121214] text-sm text-zinc-200 p-2.5 rounded border border-zinc-700/50 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition font-mono"
                  />
               </div>
               
               <div className="pt-2">
                 <button 
                   type="button" 
                   onClick={() => { handleFetchContestants(); handleFetchProblems(); }}
                   className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-200 py-2.5 rounded text-sm font-semibold transition"
                 >
                   Fetch Data
                 </button>
               </div>
            </div>

            <div className="mt-6 pt-4 border-t border-zinc-800">
               {errorMessage && (
                  <div className="mb-4 text-xs font-medium bg-rose-950/40 text-rose-400 border border-rose-900/50 rounded-md p-3">
                     {errorMessage}
                  </div>
               )}
               <button 
                 type="submit" 
                 disabled={isJudging}
                 className="w-full relative group overflow-hidden rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white font-bold py-3 text-sm transition-all"
               >
                 <div className="flex items-center justify-center gap-2 relative z-10">
                   {isJudging ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Judging in Progress...
                      </>
                   ) : (
                      <>
                        <Play className="w-4 h-4" />
                        Start Batch Grading
                      </>
                   )}
                 </div>
                 {!isJudging && (
                    <div className="absolute inset-0 h-full w-full bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
                 )}
               </button>
            </div>
          </form>
        </div>

        {/* Results Panel */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#0f0f11] rounded-lg border border-zinc-800 shadow-xl shadow-black/80 overflow-hidden">
          <div className="h-12 border-b border-zinc-800 bg-[#121214] flex flex-col justify-center px-4">
             <div className="flex items-center justify-between">
                <div className="text-2xs text-zinc-500">Double-click a cell to view judging details. Click the Settings icon on problem headers to configure.</div>
                {judgeResult && (
                  <button onClick={handleExportExcel} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold uppercase tracking-wider rounded transition">
                    <Download className="w-3 h-3" /> Export Excel
                  </button>
                )}
             </div>
          </div>

          <div className="flex-1 overflow-auto bg-[#09090b]">
             {contestantsList.length === 0 && problemsList.length === 0 ? (
               <div className="w-full h-full min-h-[400px] flex flex-col items-center justify-center text-center text-zinc-500">
                  <Terminal className="w-8 h-8 text-zinc-700 mb-3" />
                  <p className="text-xs max-w-sm">
                    Enter the absolute paths for contestants and testcases, then click <strong className="text-zinc-300">Fetch</strong> to populate the scoreboard.
                  </p>
               </div>
             ) : (
               <table className="w-full text-xs text-left relative border-collapse">
                 <thead className="bg-[#121214] sticky top-0 z-10 shadow-sm border-b border-zinc-800">
                   <tr>
                     <th className="px-4 py-3 font-semibold text-zinc-300 whitespace-nowrap min-w-[200px] border-b border-zinc-800 sticky left-0 bg-[#121214] z-20">
                       <div className="flex items-center gap-3">
                         <input
                           type="checkbox"
                           checked={contestantsList.length > 0 && contestantsList.every(c => selectedContestants[c])}
                           onChange={(e) => {
                              const checked = e.target.checked;
                              const newSel = {};
                              contestantsList.forEach(c => newSel[c] = checked);
                              setSelectedContestants(prev => ({...prev, ...newSel}));
                           }}
                           className="w-4 h-4 bg-zinc-900 border-zinc-700 rounded text-indigo-500 cursor-pointer"
                           title="Select all contestants"
                         />
                         <span>Contestant</span>
                       </div>
                     </th>`;

code = code.replace(damagedChunkRegex, correctChunk);
fs.writeFileSync('src/App.tsx', code);
