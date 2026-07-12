import React, { useEffect, useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import {
  Code2,
  Server,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Play,
  Terminal,
  FolderOpen,
  FolderLock,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Download, Timer,
  ArrowUpDown
} from "lucide-react";
import { TestCaseRun, BatchJudgeResult, HostStatus, ContestantResult, ProblemResult, ProblemConfig } from "./types";
import ProblemConfigModal from "./components/ProblemConfigModal";
import ProgressWindow from "./components/ProgressWindow";
import JudgingDetailsModal from "./components/JudgingDetailsModal";

const TestcasesIcon = () => (
  <svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
    <path d="M4 10C4 8.89543 4.89543 8 6 8H18L24 14H42C43.1046 14 44 14.8954 44 16V40C44 41.1046 43.1046 42 42 42H6C4.89543 42 4 41.1046 4 40V10Z" fill="#F59E0B" stroke="#D97706" strokeWidth="2"/>
    <path d="M28 20L34 26M34 26L28 32M34 26H18C15 26 14 28 14 32" stroke="#10B981" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ContestantsIcon = () => (
  <svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
    <circle cx="16" cy="18" r="6" fill="#10B981" />
    <path d="M8 36C8 30 12 28 16 28C20 28 24 30 24 36" fill="#10B981" />
    <circle cx="24" cy="14" r="6" fill="#FBBF24" />
    <path d="M16 32C16 26 20 24 24 24C28 24 32 26 32 32" fill="#FBBF24" />
    <circle cx="32" cy="22" r="6" fill="#3B82F6" />
    <path d="M24 40C24 34 28 32 32 32C36 32 40 34 40 40" fill="#3B82F6" />
  </svg>
);

const API_BASE = window.location.origin.includes("localhost:3000") ? "" : "http://localhost:3000";

export default function App() {
  const [thisinhPath, setThisinhPath] = useState<string>("");
  const [testPath, setTestPath] = useState<string>("");
  const [timeLimit, setTimeLimit] = useState<number>(1000);

  const [contestantsList, setContestantsList] = useState<string[]>([]);
  const [problemsList, setProblemsList] = useState<string[]>([]);
  const [problemConfigs, setProblemConfigs] = useState<Record<string, ProblemConfig>>({});
  const [selectedContestants, setSelectedContestants] = useState<Record<string, boolean>>({});
  const [selectedProblems, setSelectedProblems] = useState<Record<string, boolean>>({});
  const [customCheckersMap, setCustomCheckersMap] = useState<Record<string, string[]>>({});
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [contestantSort, setContestantSort] = useState<'default' | 'asc' | 'desc' | 'score'>('default');
  const [problemSort, setProblemSort] = useState<'default' | 'asc' | 'desc'>('default');

  // Modals
  const [activeConfigProblem, setActiveConfigProblem] = useState<string | null>(null);
  const [activeDetails, setActiveDetails] = useState<{ cont: string; data: ProblemResult } | null>(null);
  const [loadModal, setLoadModal] = useState<'tests' | 'contestants' | null>(null);
  const [modalPath, setModalPath] = useState<string>("");
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Diagnostic states


  // Judge process states
  const [isJudging, setIsJudging] = useState<boolean>(false);
  const [judgeResult, setJudgeResult] = useState<BatchJudgeResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progressState, setProgressState] = useState<{ contestant: string, problem: string, action: string, percent: number } | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const displayedProblems = useMemo(() => {
    let list = problemsList;
    if (problemSort === 'asc') {
      return [...list].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } else if (problemSort === 'desc') {
      return [...list].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    }
    return list;
  }, [problemsList, problemSort]);

  const displayedContestants = useMemo(() => {
    let list = contestantsList;
    if (searchTerm.trim()) {
      const lower = searchTerm.toLowerCase();
      list = list.filter(c => c.toLowerCase().includes(lower));
    }
    
    if (contestantSort === 'score') {
      const activeProblems = problemsList.filter(p => selectedProblems[p]);
      const scoresMap: Record<string, number> = {};
      
      list.forEach(cont => {
        const ctData = judgeResult?.contestants.find(c => c.contestantName === cont);
        const totalScore = ctData && ctData.problems 
          ? ctData.problems
              .filter(p => p && p.problemName && activeProblems.some(ap => ap.toLowerCase() === p.problemName.toLowerCase()))
              .reduce((acc, p) => acc + (p.summary?.score ?? 0), 0)
          : 0;
        scoresMap[cont] = totalScore;
      });
      
      return [...list].sort((a, b) => (scoresMap[b] ?? 0) - (scoresMap[a] ?? 0));
    } else if (contestantSort === 'asc') {
      return [...list].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } else if (contestantSort === 'desc') {
      return [...list].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    }
    
    return list;
  }, [contestantsList, searchTerm, contestantSort, judgeResult, selectedProblems, problemsList]);

  const handleFetchContestants = async (pathOverride?: string) => {
    const targetPath = pathOverride ?? thisinhPath;
    if (!targetPath.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/api/fetch-contestants?path=${encodeURIComponent(targetPath)}`);
      const data = await res.json();
      if (data.success && data.data) {
          setContestantsList(data.data);
          const newSelected: Record<string, boolean> = {};
          data.data.forEach((c: string) => newSelected[c] = true);
          setSelectedContestants(prev => ({...prev, ...newSelected}));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleFetchProblems = async (pathOverride?: string) => {
    const targetPath = pathOverride ?? testPath;
    if (!targetPath.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/api/fetch-problems?path=${encodeURIComponent(targetPath)}`);
      const data = await res.json();
      if (data.success && data.data) {
         setProblemsList(data.data);
         if (data.customCheckers) {
           setCustomCheckersMap(data.customCheckers);
         }
         // Initialize configs for new problems
         const newSelectedP: Record<string, boolean> = {};
         data.data.forEach((p: string) => newSelectedP[p] = true);
         setSelectedProblems(prev => ({...prev, ...newSelectedP}));
         
         setProblemConfigs(prev => {
            const up = { ...prev };
            data.data.forEach((p: string) => {
               if (!up[p]) up[p] = { useStdIO: false, totalScore: null, defaultScore: 1, testScores: {} };
            });
            return up;
         });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const activeLoadModalRef = useRef<'tests' | 'contestants' | null>(null);

  useEffect(() => {
    activeLoadModalRef.current = loadModal;
    if (loadModal) {
      setModalPath(loadModal === 'tests' ? testPath : thisinhPath);
    }
  }, [loadModal, testPath, thisinhPath]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function setupTauri() {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const appWebview = getCurrentWebview();
        unlisten = await appWebview.onDragDropEvent((event) => {
          if (event.payload.type === 'drop') {
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
              const absolutePath = paths[0];
              console.log("Tauri file drop event path:", absolutePath);
              
              const currentModal = activeLoadModalRef.current;
              if (currentModal === 'tests') {
                setTestPath(absolutePath);
                handleFetchProblems(absolutePath);
                setLoadModal(null);
              } else if (currentModal === 'contestants') {
                setThisinhPath(absolutePath);
                handleFetchContestants(absolutePath);
                setLoadModal(null);
              }
            }
          }
        });
      } catch (e) {
        console.log("Tauri drag-drop not supported in this environment");
      }
    }
    setupTauri();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleRunJudge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!thisinhPath.trim()) {
      setErrorMessage("Please enter the path to the contestants folder.");
      return;
    }
    if (!testPath.trim()) {
      setErrorMessage("Please enter the path to the testcases folder.");
      return;
    }

    setErrorMessage("");
    setIsJudging(true);
    setJudgeResult({ success: true, contestants: [] });
    
    const newJobId = Math.random().toString(36).substring(7);
    setJobId(newJobId);
    setProgressState({ contestant: "", problem: "", action: "Initializing...", percent: 0 });

    try {
      const activeContestantsArray = displayedContestants.filter(k => selectedContestants[k]);
      const activeProblemsArray = displayedProblems.filter(k => selectedProblems[k]);
      
      abortControllerRef.current = new AbortController();
      const response = await fetch(`${API_BASE}/api/batch-judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thisinhPath, testPath, timeLimit, problemConfigs, targetContestants: activeContestantsArray, targetProblems: activeProblemsArray, jobId: newJobId }),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        throw new Error("An unexpected judging error occurred.");
      }

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === "progress") {
                setProgressState(event.data);
              } else if (event.type === "problem_completed") {
                setJudgeResult(prev => {
                  if (!prev) return prev;
                  const newRes = { ...prev };
                  let ct = newRes.contestants.find(c => c.contestantName === event.data.contestant);
                  if (!ct) {
                    ct = { contestantName: event.data.contestant, problems: [] };
                    newRes.contestants.push(ct);
                  }
                  
                  const pIdx = ct.problems.findIndex(p => p.problemName === event.data.problemResult.problemName);
                  if (pIdx >= 0) {
                     ct.problems[pIdx] = event.data.problemResult;
                  } else {
                     ct.problems.push(event.data.problemResult);
                  }
                  
                  return newRes;
                });
              } else if (event.type === "done" || event.type === "error") {
                if (event.type === "error") setErrorMessage(event.data.message);
                setIsJudging(false);
                setJobId(null);
                setProgressState(null);
              }
            } catch (err) {}
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return; // User intentionally aborted
      }
      setErrorMessage(err.message || "Something went wrong during local execution.");
      setIsJudging(false);
      setJobId(null);
      setProgressState(null);
    }
  };

  const handleTerminate = async () => {
     if (jobId) {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        await fetch(`${API_BASE}/api/batch-judge/cancel`, {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ jobId })
        });
        setIsJudging(false);
        setJobId(null);
        setProgressState(null);
     }
  };

  const getCellDisplay = (contName: string, probName: string) => {
     if (!judgeResult) return <td key={probName} className="p-3 text-center border-l border-zinc-800 text-zinc-700">-</td>;
     const ct = judgeResult.contestants.find(c => c.contestantName === contName);
     if (!ct || !ct.problems) return <td key={probName} className="p-3 text-center border-l border-zinc-800 text-zinc-700">-</td>;
     const prob = ct.problems.find(p => p && p.problemName && p.problemName.toLowerCase() === probName.toLowerCase());
     if (!prob) return <td key={probName} className="p-3 text-center border-l border-zinc-800 text-zinc-700">-</td>;
     
     let displayText: React.ReactNode = prob.summary?.score ?? 0;
     let colorClass = "text-zinc-400";
     
     if (prob.compileStatus === "SKIPPED" && prob.compileError === "not_found") {
       displayText = "Not found";
       colorClass = "text-zinc-600 bg-zinc-950/20";
     } else if (prob.compileStatus === "CE") {
       displayText = "CE";
       colorClass = "text-rose-500 font-bold bg-rose-950/20";
     } else {
       const status = prob.summary?.status;
       if (status === "AC") colorClass = "text-emerald-400 font-bold bg-emerald-950/20";
       else if (status === "PARTIAL") colorClass = "text-yellow-400 font-bold bg-yellow-950/20";
       else colorClass = "text-rose-400 bg-rose-950/10";
     }

     return (
        <td 
           key={probName} 
           onDoubleClick={() => prob.compileStatus !== "SKIPPED" && setActiveDetails({ cont: contName, data: prob })}
           className={`p-3 text-center border-l border-zinc-800 cursor-pointer hover:bg-zinc-800 transition ${colorClass}`}
           title={`Status: ${prob.summary?.status || ""}\nCompile: ${prob.compileStatus || ""}`}
        >
           {displayText}
        </td>
     );
  };

  const handleExportExcel = () => {
    if (!judgeResult) return;

    const activeProblems = displayedProblems.filter(p => selectedProblems[p]);
    const activeContestantsOrder = displayedContestants.filter(c => selectedContestants[c]);
    const activeContestants = activeContestantsOrder.map(name => {
       return judgeResult.contestants.find(c => c.contestantName === name) || { contestantName: name, problems: [] };
    });

    // 1. Score Summary Sheet
    const summaryData = activeContestants.map(ct => {
      const row: Record<string, any> = { Candidate: ct.contestantName };
      let totalScore = 0;
      
      activeProblems.forEach(probName => {
        const prob = ct.problems?.find(p => p && p.problemName && p.problemName.toLowerCase() === probName.toLowerCase());
        if (!prob) {
          row[probName] = "Not found";
        } else if (prob.compileStatus === "SKIPPED" && prob.compileError === "not_found") {
          row[probName] = "Not found";
        } else if (prob.compileStatus === "CE") {
          row[probName] = "Compilation Error";
        } else if (prob.compileStatus !== "OK") {
          row[probName] = "Compilation Error";
        } else {
          row[probName] = prob.summary?.score ?? 0;
          totalScore += prob.summary?.score ?? 0;
        }
      });
      row["Total Score"] = Math.round(totalScore * 10000) / 10000;
      return row;
    });

    const wsSummary = XLSX.utils.json_to_sheet(summaryData, { header: ["Candidate", ...activeProblems, "Total Score"] });

    // 2. Scoring Details Sheet
    const detailsData: any[] = [];

    activeContestants.forEach(ct => {
      let examTotal = 0;
      if (ct.problems) {
        ct.problems.filter(p => p && p.problemName && activeProblems.some(ap => ap.toLowerCase() === p.problemName.toLowerCase())).forEach(p => examTotal += p.summary?.score ?? 0);
      }
      detailsData.push({
        Candidate: ct.contestantName,
        Problems: "",
        Test: "",
        Score: Math.round(examTotal * 10000) / 10000,
        Time: "",
        Results: ""
      });

      if (ct.problems) {
        ct.problems.filter(p => p && p.problemName && activeProblems.some(ap => ap.toLowerCase() === p.problemName.toLowerCase())).forEach(prob => {
          let compileMsg = prob.compileStatus === "OK" ? "Compilation Success" : "Compilation Error";
          if (prob.compileStatus === "SKIPPED" && prob.compileError === "not_found") {
            compileMsg = "Not found";
          }
          
          detailsData.push({
            Candidate: ct.contestantName,
            Problems: prob.problemName,
            Test: "",
            Score: prob.summary?.score ?? 0,
            Time: "",
            Results: compileMsg
          });

          prob.testCases.forEach(tc => {
            let resultText = "";
            if (tc.status === "AC") {
              resultText = tc.checkerMessage || "Accepted";
            } else if (tc.status === "WA") {
              resultText = tc.checkerMessage || "Wrong Answer";
            } else if (tc.status === "TLE") {
              resultText = "Time Limit Exceeded";
            } else if (tc.status === "MLE") {
              resultText = "Memory Limit Exceeded";
            } else if (tc.status === "RE") {
              resultText = "Runtime Error" + (tc.errorDetail ? ": " + tc.errorDetail : "");
            } else if (tc.status === "CE") {
              resultText = "Compilation Error";
            } else if (tc.status === "FAIL") {
              resultText = "Checker Failed" + (tc.errorDetail ? ": " + tc.errorDetail : "");
            } else {
              resultText = tc.status;
            }

            const timeInSeconds = (tc.executionTime / 1000).toFixed(3);
            const timeLabel = `${timeInSeconds} seconds`;

            detailsData.push({
               Candidate: ct.contestantName,
               Problems: prob.problemName,
               Test: tc.name,
               Score: tc.score,
               Time: timeLabel,
               Results: resultText
            });
          });
        });
      }
    });

    const wsDetails = XLSX.utils.json_to_sheet(detailsData, { header: ["Candidate", "Problems", "Test", "Score", "Time", "Results"] });

    // Autofit helper
    const autofitColumns = (ws: XLSX.WorkSheet) => {
       if (!ws || !ws['!ref']) return;
       const cols: any[] = [];
       const range = XLSX.utils.decode_range(ws['!ref']);
       for (let col = range.s.c; col <= range.e.c; col++) {
          let maxLen = 10;
          for (let row = range.s.r; row <= range.e.r; row++) {
             const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })];
             if (cell && cell.v) {
                const len = String(cell.v).split('\n').reduce((max, line) => Math.max(max, line.length), 0);
                if (len > maxLen) maxLen = len;
             }
          }
          cols.push({ wch: maxLen + 3 });
       }
       ws['!cols'] = cols;
    };

    autofitColumns(wsSummary);
    autofitColumns(wsDetails);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsSummary, "Score Summary");
    XLSX.utils.book_append_sheet(wb, wsDetails, "Scoring Details");

    XLSX.writeFile(wb, "judging_result.xlsx");
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const absolutePath = (file as any).path || "";
      const isValidPath = /^[a-zA-Z]:[\\\/]/.test(absolutePath) || absolutePath.startsWith("\\\\") || absolutePath.startsWith("/");
      if (isValidPath) {
        setModalPath(absolutePath);
        if (loadModal === 'tests') {
          setTestPath(absolutePath);
          handleFetchProblems(absolutePath);
        } else if (loadModal === 'contestants') {
          setThisinhPath(absolutePath);
          handleFetchContestants(absolutePath);
        }
        setLoadModal(null);
      } else {
        if (file.name) {
          setModalPath(file.name);
        }
      }
    }
  };

  return (
    <div id="local-online-judge" className="h-screen bg-[#09090b] text-[#e4e4e7] font-sans flex flex-col overflow-hidden">
      <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-6 bg-[#121214] shadow-md flex-shrink-0">
        <div className="flex items-center space-x-4">
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center font-bold italic text-white shadow-md shadow-indigo-950/20">
            LJ
          </div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-semibold tracking-tight text-white">Local Batch Judge</h1>
            <span className="text-[10px] text-zinc-500 font-medium">Enterprise v2.0.0</span>
          </div>
        </div>
      </header>

      {/* Toolbar / Top Bar */}
      <div className="h-14 bg-[#0f0f11] border-b border-zinc-800 flex items-center justify-between px-6 flex-shrink-0">
        <div className="flex items-center gap-4">
          {/* Testcases Directory button */}
          <button
            onClick={() => { setLoadModal('tests'); setModalPath(testPath); }}
            className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold rounded border border-zinc-700/50 transition cursor-pointer shadow-sm"
            title="Load Testcases Directory"
          >
            <TestcasesIcon />
            <span>Testcases Dir</span>
          </button>

          {/* Contestants Directory button */}
          <button
            onClick={() => { setLoadModal('contestants'); setModalPath(thisinhPath); }}
            className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold rounded border border-zinc-700/50 transition cursor-pointer shadow-sm"
            title="Load Contestants Directory"
          >
            <ContestantsIcon />
            <span>Contestants Dir</span>
          </button>

          {/* Time limit (ms) input */}
          <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1">
            <Timer className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Limit:</span>
            <input
              type="number"
              value={timeLimit}
              onChange={(e) => setTimeLimit(Number(e.target.value))}
              className="bg-transparent text-xs text-zinc-200 font-bold focus:outline-none w-16 font-mono"
            />
            <span className="text-[10px] text-zinc-500 font-medium">ms</span>
          </div>

          {/* Reload button */}
          <button
            onClick={() => { handleFetchContestants(); handleFetchProblems(); }}
            className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded border border-zinc-700/50 transition cursor-pointer"
            title="Reload tests and contestants"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Start Grading trigger */}
        <div className="flex items-center gap-3">
          {errorMessage && (
            <div className="text-[10px] font-medium bg-rose-950/40 text-rose-400 border border-rose-900/50 rounded px-3 py-1 max-w-xs truncate">
              {errorMessage}
            </div>
          )}
          <button
            onClick={handleRunJudge}
            disabled={isJudging}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold px-4 py-1.5 rounded text-xs transition-all shadow-md shadow-indigo-950/20 flex items-center gap-2 cursor-pointer"
          >
            {isJudging ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Grading...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Start Grading</span>
              </>
            )}
          </button>
        </div>
      </div>

      <main className="flex-1 overflow-hidden p-6 w-full flex flex-col relative bg-[#09090b]">
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
                    Load contestants and testcases folders using the toolbar above to populate the scoreboard.
                  </p>
               </div>
             ) : (
               <table className="w-full text-xs text-left relative border-collapse">
                  <thead className="bg-[#121214] sticky top-0 z-20 shadow-sm border-b border-zinc-800">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-zinc-300 whitespace-nowrap min-w-[220px] border-b border-zinc-800 sticky left-0 bg-[#121214] z-30">
                        <div className="flex items-center gap-3 justify-between">
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
                          <button 
                             type="button"
                             onClick={() => {
                                setContestantSort(prev => {
                                   if (prev === 'default') return 'asc';
                                   if (prev === 'asc') return 'desc';
                                   return 'default';
                                });
                             }}
                             className={`p-1 hover:bg-zinc-800 rounded transition ${contestantSort !== 'default' && contestantSort !== 'score' ? 'text-indigo-400 font-bold' : 'text-zinc-600'}`}
                             title="Sort alphabetically (A-Z / Z-A)"
                          >
                             <ArrowUpDown className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </th>
                      {displayedProblems.map(prob => (
                        <th 
                          key={prob} 
                          className="px-4 py-3 font-semibold text-zinc-300 whitespace-nowrap text-center border-l border-b border-zinc-800 transition group hover:bg-zinc-800"
                        >
                          <div className="flex items-center justify-center gap-2">
                            <input
                              type="checkbox"
                              checked={!!selectedProblems[prob]}
                              onChange={(e) => setSelectedProblems(prev => ({...prev, [prob]: e.target.checked}))}
                              className="w-4 h-4 bg-zinc-900 border-zinc-700 rounded text-indigo-500 cursor-pointer"
                              title="Select problem for grading"
                            />
                            <span className="cursor-pointer" onClick={() => setActiveConfigProblem(prob)} title="Click to configure scoring & I/O">{prob}</span>
                            <button 
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setActiveConfigProblem(prob); }}
                              className="text-zinc-500 group-hover:text-indigo-400 transition cursor-pointer"
                            >
                              <Terminal className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </th>
                      ))}
                      <th className="px-4 py-3 font-semibold text-indigo-400 whitespace-nowrap text-center border-l border-b border-zinc-800 sticky right-0 bg-[#121214] z-20">
                        <div className="flex items-center justify-center gap-2">
                          <input
                            type="checkbox"
                            checked={displayedProblems.length > 0 && displayedProblems.every(p => selectedProblems[p])}
                            onChange={(e) => {
                               const checked = e.target.checked;
                               const newSel: Record<string, boolean> = {};
                               displayedProblems.forEach(p => newSel[p] = checked);
                               setSelectedProblems(prev => ({...prev, ...newSel}));
                            }}
                            className="w-4 h-4 bg-zinc-900 border-zinc-700 rounded text-indigo-500 cursor-pointer"
                            title="Select all problems"
                          />
                          <span>TOTAL</span>
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50">
                     {displayedContestants.map(cont => {
                       const ctData = judgeResult?.contestants.find(c => c.contestantName === cont);
                       const totalScore = ctData && ctData.problems ? ctData.problems.filter(p => p && p.problemName && Object.keys(selectedProblems).some(k => selectedProblems[k] && k.toLowerCase() === p.problemName.toLowerCase())).reduce((acc, p) => acc + (p.summary?.score ?? 0), 0) : 0;
                       return (
                        <tr key={cont} className={`transition ${selectedContestants[cont] ? "hover:bg-zinc-900/30" : "opacity-50"}`}>
                          <td className="px-4 py-3 font-mono text-zinc-300 sticky left-0 bg-[#0f0f11] z-10 border-r border-zinc-800">
                            <div className="flex items-center gap-3">
                              <input 
                                type="checkbox"
                                checked={!!selectedContestants[cont]}
                                onChange={(e) => setSelectedContestants(prev => ({...prev, [cont]: e.target.checked}))}
                                className="w-4 h-4 bg-zinc-900 border-zinc-700 rounded text-indigo-500 cursor-pointer"
                              />
                              {cont}
                            </div>
                          </td>
                          {displayedProblems.map(prob => getCellDisplay(cont, prob))}
                          <td className="px-4 py-3 text-center font-bold text-indigo-300 border-l border-zinc-800 bg-indigo-950/5 sticky right-0 bg-[#101012] z-10">
                            {judgeResult ? totalScore.toFixed(2) : "-"}
                          </td>
                        </tr>
                       );
                     })}
                  </tbody>
                </table>
             )}
          </div>
        </div>
      </main>

      {/* Directory Selector Modal */}
      {loadModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div 
            className="w-full max-w-lg bg-[#0f0f11] border border-zinc-800 rounded-lg shadow-2xl overflow-hidden flex flex-col"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between bg-[#121214]">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                {loadModal === 'tests' ? "Load problems list" : "Load contestants list"}
              </h3>
              <button onClick={() => setLoadModal(null)} className="text-zinc-500 hover:text-zinc-300 text-sm">✕</button>
            </div>
            
            <div className="p-6 space-y-4 flex-1">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={modalPath}
                  onChange={(e) => setModalPath(e.target.value)}
                  placeholder={loadModal === 'tests' ? "D:\\path\\to\\testcases" : "D:\\path\\to\\contestants"}
                  className="flex-1 bg-[#121214] text-xs text-zinc-200 p-2.5 rounded border border-zinc-700/50 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition font-mono"
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await fetch(`${API_BASE}/api/select-directory`);
                      const data = await res.json();
                      if (data.success && data.path) {
                        setModalPath(data.path);
                      }
                    } catch (e) {
                      console.error("Browse directory failed:", e);
                    }
                  }}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold rounded border border-zinc-700/50 transition cursor-pointer"
                >
                  Browse...
                </button>
              </div>

              {/* Drag and drop zone */}
              <div 
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center gap-2 transition-all ${
                  isDragging 
                    ? "border-indigo-500 bg-indigo-950/20 scale-[1.02]" 
                    : "border-zinc-800 bg-[#09090b]/50 hover:border-zinc-700"
                }`}
              >
                <FolderOpen className={`w-8 h-8 transition-colors ${isDragging ? "text-indigo-400" : "text-zinc-600"}`} />
                <span className={`text-xs font-medium transition-colors ${isDragging ? "text-indigo-300 font-bold" : "text-zinc-400"}`}>
                  {isDragging ? "Drop here!" : "Drag & drop folder here"}
                </span>
                <span className="text-[10px] text-zinc-600">or use the input/browse above</span>
              </div>
            </div>

            <div className="px-5 py-3.5 border-t border-zinc-800 bg-[#121214] flex justify-end gap-2">
              <button 
                onClick={() => setLoadModal(null)} 
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold rounded transition cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  if (loadModal === 'tests') {
                    setTestPath(modalPath);
                    handleFetchProblems(modalPath);
                  } else {
                    setThisinhPath(modalPath);
                    handleFetchContestants(modalPath);
                  }
                  setLoadModal(null);
                }}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded transition cursor-pointer"
              >
                Load
              </button>
            </div>
          </div>
        </div>
      )}

      {progressState && (
        <ProgressWindow
           currentContestant={progressState.contestant}
           currentProblem={progressState.problem}
           action={progressState.action}
           percent={progressState.percent}
           onTerminate={handleTerminate}
        />
      )}
      
      {activeConfigProblem && (
        <ProblemConfigModal 
           problemName={activeConfigProblem}
           testPath={testPath}
           initialConfig={problemConfigs[activeConfigProblem] || { useStdIO: false, totalScore: null, defaultScore: 1, testScores: {} }}
           onSave={(pName, conf) => setProblemConfigs(prev => ({...prev, [pName]: conf}))}
           onClose={() => setActiveConfigProblem(null)}
           customCheckers={customCheckersMap[activeConfigProblem] || []}
        />
      )}

      {activeDetails && (
        <JudgingDetailsModal 
           contestantName={activeDetails.cont}
           data={activeDetails.data}
           onClose={() => setActiveDetails(null)}
        />
      )}
    </div>
  );
}
