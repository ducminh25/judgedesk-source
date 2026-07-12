import React, { useEffect, useState, useMemo } from "react";
import { X, CheckSquare, Square, Settings, Layout, Edit, AlertCircle, Plus, Trash2 } from "lucide-react";
import { ProblemConfig, PolygonConfig } from "../types";

interface Props {
  problemName: string;
  testPath: string; // the generic /TEST/ dir
  initialConfig: ProblemConfig;
  onSave: (problemName: string, config: ProblemConfig) => void;
  onClose: () => void;
  customCheckers?: string[];
}

interface TestDetail {
  name: string;
  preview: string;
  size: number;
}

export default function ProblemConfigModal({ problemName, testPath, initialConfig, onSave, onClose, customCheckers = [] }: Props) {
  const [config, setConfig] = useState<ProblemConfig>(initialConfig);
  const [polyConfig, setPolyConfig] = useState<PolygonConfig>({
    enableGroups: false,
    tests: {},
    groups: {}
  });
  
  const [testDetails, setTestDetails] = useState<TestDetail[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  
  const [showContent, setShowContent] = useState(false);
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set());
  
  // Popover state
  const [popover, setPopover] = useState<{ type: 'points' | 'group' | 'time' | 'batchPoints' | 'batchGroup' | 'batchTime', testName?: string, x: number, y: number } | null>(null);
  const [popoverInput, setPopoverInput] = useState("");
  const [batchPointsTotal, setBatchPointsTotal] = useState("");

  const [useStdIn, setUseStdIn] = useState<boolean>(initialConfig.useStdIn ?? initialConfig.useStdIO ?? false);
  const [useStdOut, setUseStdOut] = useState<boolean>(initialConfig.useStdOut ?? initialConfig.useStdIO ?? false);
  const [inputFile, setInputFile] = useState<string>(initialConfig.inputFile || `${problemName}.inp`);
  const [outputFile, setOutputFile] = useState<string>(initialConfig.outputFile || `${problemName}.out`);
  
  const problemDirPath = testPath + "/" + problemName;

  useEffect(() => {
    const fetchDirs = async () => {
      setIsLoading(true);
      try {
        const url = `/api/fetch-polygon-tests?path=${encodeURIComponent(problemDirPath)}&problem=${encodeURIComponent(problemName)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.success && data.data) {
          setTestDetails(data.data);
          
          // Auto-initialize missing tests with default config
          setPolyConfig(prev => {
            const next = { ...prev, tests: { ...prev.tests } };
            data.data.forEach((t: TestDetail) => {
              if (!next.tests[t.name]) {
                next.tests[t.name] = { points: initialConfig.defaultScore };
              }
            });
            return next;
          });
        }
        
        // Fetch Config.cfg
        const confRes = await fetch(`/api/polygon-config?path=${encodeURIComponent(problemDirPath)}`);
        const confData = await confRes.json();
        if (confData.success && confData.data) {
          setPolyConfig(confData.data);
          if (confData.data.checkerType) {
            setConfig(prev => ({ ...prev, checkerType: confData.data.checkerType }));
          }
          setUseStdIn(confData.data.useStdIn ?? confData.data.useStdIO ?? false);
          setUseStdOut(confData.data.useStdOut ?? confData.data.useStdIO ?? false);
          setInputFile(confData.data.inputFile || `${problemName}.inp`);
          setOutputFile(confData.data.outputFile || `${problemName}.out`);
        }
      } catch (e) {
        console.error("Failed to fetch test folders", e);
      } finally {
        setIsLoading(false);
      }
    };
    fetchDirs();
  }, [problemDirPath, problemName]);

  const handleSave = async () => {
    try {
      const configToSave = {
        ...polyConfig,
        checkerType: config.checkerType || "C1",
        useStdIn,
        useStdOut,
        inputFile,
        outputFile
      };
      await fetch("/api/polygon-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: problemDirPath, config: configToSave })
      });
      
      const newConfig = { 
        ...config, 
        checkerType: config.checkerType || "C1", 
        useStdIn, 
        useStdOut, 
        inputFile, 
        outputFile, 
        polygonConfig: polyConfig 
      };
      onSave(problemName, newConfig);
      onClose();
    } catch (e) {
      console.error(e);
      alert("Failed to save configuration");
    }
  };

  const handleSelectAll = () => {
    if (selectedTests.size === testDetails.length) {
      setSelectedTests(new Set());
    } else {
      setSelectedTests(new Set(testDetails.map(t => t.name)));
    }
  };

  const toggleSelectTest = (name: string) => {
    const next = new Set(selectedTests);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelectedTests(next);
  };

  const savePopover = () => {
    if (!popover) return;
    
    setPolyConfig(prev => {
      const next = { ...prev, tests: { ...prev.tests }, groups: { ...prev.groups } };
      
      if (popover.type === 'points' && popover.testName) {
        next.tests[popover.testName].points = popoverInput ? parseFloat(popoverInput) : 1;
      } else if (popover.type === 'time' && popover.testName) {
        const tVal = parseFloat(popoverInput);
        next.tests[popover.testName].timeLimit = !isNaN(tVal) && tVal > 0 ? tVal : undefined;
      } else if (popover.type === 'group' && popover.testName) {
        const groupName = popoverInput.trim();
        if (groupName) {
          next.tests[popover.testName].group = groupName;
          if (!next.groups[groupName]) {
            next.groups[groupName] = { policy: "EACH_TEST", dependencies: [] };
          }
        } else {
          delete next.tests[popover.testName as any].group;
        }
      } else if (popover.type === 'batchGroup') {
        const groupName = popoverInput.trim();
        Array.from(selectedTests).forEach((tName: any) => {
          if (!next.tests[tName as string]) next.tests[tName as string] = { points: 1 };
          if (groupName) {
            next.tests[tName as string].group = groupName;
            if (!next.groups[groupName]) next.groups[groupName] = { policy: "EACH_TEST", dependencies: [] };
          } else {
            delete next.tests[tName as string].group;
          }
        });
        setSelectedTests(new Set());
      } else if (popover.type === 'batchPoints') {
        const points = popoverInput ? parseFloat(popoverInput) : 1;
        Array.from(selectedTests).forEach((tName: any) => {
          if (!next.tests[tName as string]) next.tests[tName as string] = { points: 1 };
          next.tests[tName as string].points = points;
        });
        setSelectedTests(new Set());
      } else if (popover.type === 'batchTime') {
        const tVal = parseFloat(popoverInput);
        const timeLimit = !isNaN(tVal) && tVal > 0 ? tVal : undefined;
        Array.from(selectedTests).forEach((tName: any) => {
          if (!next.tests[tName as string]) next.tests[tName as string] = { points: 1 };
          next.tests[tName as string].timeLimit = timeLimit;
        });
        setSelectedTests(new Set());
      }
      return next;
    });
    setPopover(null);
  };

  const hasCycle = (groups: PolygonConfig['groups'], startGroup: string, newDep: string) => {
    const visited = new Set<string>();
    const stack = [newDep];
    
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === startGroup) return true;
      if (visited.has(current)) continue;
      
      visited.add(current);
      if (groups[current]?.dependencies) {
        stack.push(...groups[current].dependencies);
      }
    }
    return false;
  };

  const addDependency = (groupName: string, depName: string) => {
    if (groupName === depName) return;
    if (hasCycle(polyConfig.groups, groupName, depName)) {
      alert("Cannot add dependency because of cyclic dependence");
      return;
    }
    
    setPolyConfig(prev => {
      const next = { ...prev, groups: { ...prev.groups } };
      const deps = new Set(next.groups[groupName].dependencies);
      deps.add(depName);
      next.groups[groupName] = { ...next.groups[groupName], dependencies: Array.from(deps) };
      return next;
    });
  };

  const removeDependency = (groupName: string, depName: string) => {
    setPolyConfig(prev => {
      const next = { ...prev, groups: { ...prev.groups } };
      next.groups[groupName] = {
        ...next.groups[groupName],
        dependencies: next.groups[groupName].dependencies.filter(d => d !== depName)
      };
      return next;
    });
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    return (bytes / 1024).toFixed(1) + " KB";
  };

  const totalPoints = useMemo(() => {
    return (Object.values(polyConfig.tests) as any[]).reduce((acc, t) => acc + (t.points || 0), 0);
  }, [polyConfig.tests]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#0f0f11] border border-zinc-800 rounded-lg w-full max-w-4xl shadow-2xl flex flex-col max-h-[95vh]" onClick={() => popover && setPopover(null)}>
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <h3 className="text-zinc-200 font-bold tracking-wider uppercase text-xs flex items-center gap-2">
            <Settings className="w-4 h-4 text-indigo-400" />
            Config: <span className="text-indigo-400">{problemName}</span>
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Basic Config */}
        <div className="p-4 border-b border-zinc-800 space-y-3 bg-zinc-950/20">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Input Config */}
            <div className="flex flex-col gap-1.5 bg-zinc-900/40 p-3 rounded border border-zinc-800/80">
              <div className="flex items-center justify-between">
                <span className="text-zinc-300 text-xs font-bold uppercase tracking-wider">Input File</span>
                <label className="flex items-center gap-1.5 text-zinc-400 text-2xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useStdIn}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setUseStdIn(checked);
                    }}
                    className="w-3.5 h-3.5 rounded text-indigo-500"
                  />
                  Use standard input
                </label>
              </div>
              <input
                type="text"
                value={useStdIn ? "stdin" : inputFile}
                disabled={useStdIn}
                onChange={(e) => setInputFile(e.target.value)}
                placeholder={`${problemName}.inp`}
                className="bg-zinc-950 border border-zinc-700/80 rounded px-2.5 py-1.5 text-zinc-200 text-xs disabled:opacity-50 disabled:bg-zinc-900 disabled:text-zinc-500 outline-none focus:border-indigo-500 transition font-mono"
              />
            </div>

            {/* Output Config */}
            <div className="flex flex-col gap-1.5 bg-zinc-900/40 p-3 rounded border border-zinc-800/80">
              <div className="flex items-center justify-between">
                <span className="text-zinc-300 text-xs font-bold uppercase tracking-wider">Output File</span>
                <label className="flex items-center gap-1.5 text-zinc-400 text-2xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useStdOut}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setUseStdOut(checked);
                    }}
                    className="w-3.5 h-3.5 rounded text-indigo-500"
                  />
                  Use standard output
                </label>
              </div>
              <input
                type="text"
                value={useStdOut ? "stdout" : outputFile}
                disabled={useStdOut}
                onChange={(e) => setOutputFile(e.target.value)}
                placeholder={`${problemName}.out`}
                className="bg-zinc-950 border border-zinc-700/80 rounded px-2.5 py-1.5 text-zinc-200 text-xs disabled:opacity-50 disabled:bg-zinc-900 disabled:text-zinc-500 outline-none focus:border-indigo-500 transition font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-center gap-2 bg-zinc-900/40 p-2.5 rounded border border-zinc-800/80">
              <label className="text-zinc-300 text-[11px] font-semibold cursor-pointer w-24">Memory (MB)</label>
              <input
                 type="number"
                 placeholder="256"
                 value={config.memoryLimit ?? ""}
                 onChange={(e) => setConfig({...config, memoryLimit: e.target.value ? Number(e.target.value) : undefined})}
                 className="flex-1 bg-zinc-950 border border-zinc-700/80 rounded px-2.5 py-1.5 text-zinc-200 text-xs focus:border-indigo-500 transition outline-none"
              />
            </div>
            <div className="flex items-center gap-2 bg-zinc-900/40 p-2.5 rounded border border-zinc-800/80">
              <label className="text-zinc-300 text-[11px] font-semibold cursor-pointer w-24">Grading Type</label>
              <select
                 value={config.checkerType || "C1"}
                 onChange={(e) => setConfig({...config, checkerType: e.target.value})}
                 className="flex-1 bg-[#121214] border border-zinc-700/80 rounded px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
              >
                <option value="C1">C1</option>
                <option value="C2">C2</option>
                <option value="C3">C3</option>
                <option value="C4">C4</option>
                <option value="C5">C5</option>
                {customCheckers.map(chk => (
                  <option key={chk} value={chk}>{chk}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-5 flex-1 overflow-y-auto font-sans text-xs space-y-6">
          
          {/* Toggles */}
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-zinc-300 font-medium cursor-pointer">
              <input type="checkbox" checked={polyConfig.enableGroups} onChange={e => setPolyConfig({...polyConfig, enableGroups: e.target.checked})} className="w-4 h-4" />
              Enable groups?
            </label>
            <label className="flex items-center gap-2 text-zinc-300 font-medium cursor-pointer">
              <input type="checkbox" checked={showContent} onChange={e => setShowContent(e.target.checked)} className="w-4 h-4" />
              Show content?
            </label>
          </div>

          {/* Test Table & Batch Actions */}
          <div className="space-y-2">
            {/* Batch Action Bar */}
            {selectedTests.size > 0 && (
              <div className="bg-indigo-950/40 border border-indigo-900/50 rounded-lg p-3 flex items-center justify-between z-10">
                <span className="text-indigo-300 font-bold text-[10px] uppercase tracking-wider">{selectedTests.size} selected</span>
                <div className="flex gap-2">
                  <button onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setPopover({ type: 'batchPoints', x: rect.left, y: rect.bottom + 8 });
                    setPopoverInput("");
                    setBatchPointsTotal("");
                  }} className="px-2.5 py-1 bg-indigo-900 hover:bg-indigo-800 text-indigo-100 rounded text-2xs font-bold uppercase tracking-wider">Points</button>
                  <button onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setPopover({ type: 'batchTime', x: rect.left, y: rect.bottom + 8 });
                    setPopoverInput("1.0");
                  }} className="px-2.5 py-1 bg-indigo-900 hover:bg-indigo-800 text-indigo-100 rounded text-2xs font-bold uppercase tracking-wider">Time Limit</button>
                  {polyConfig.enableGroups && (
                    <button onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setPopover({ type: 'batchGroup', x: rect.left, y: rect.bottom + 8 });
                      setPopoverInput("");
                    }} className="px-2.5 py-1 bg-indigo-900 hover:bg-indigo-800 text-indigo-100 rounded text-2xs font-bold uppercase tracking-wider">Group</button>
                  )}
                </div>
              </div>
            )}

            <div className="border border-zinc-800 rounded-lg overflow-hidden bg-[#151518] relative">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-400 border-b border-zinc-800">
                    <th className="p-3 w-10 text-center">
                      <button onClick={handleSelectAll} className="hover:text-zinc-200">
                        {selectedTests.size === testDetails.length && testDetails.length > 0 ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </button>
                    </th>
                    <th className="p-3 w-32">Test Name</th>
                    {showContent && <th className="p-3">Content</th>}
                    <th className="p-3 w-24">Size</th>
                    <th className="p-3 w-28">Time Limit</th>
                    {polyConfig.enableGroups && <th className="p-3 w-32">Group</th>}
                    <th className="p-3 w-24 text-right">
                      <div>Points</div>
                      <div className="text-indigo-400 text-2xs normal-case">{totalPoints} total</div>
                    </th>
                    <th className="p-3 w-36 text-center">Actions</th>
                  </tr>
                </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={8} className="p-8 text-center text-zinc-500 animate-pulse">Loading tests...</td></tr>
                ) : testDetails.map((tc, idx) => {
                  const tconf = polyConfig.tests[tc.name] || { points: 1 };
                  const tcTimeLimit = tconf.timeLimit !== undefined ? tconf.timeLimit : 1.0;
                  return (
                    <tr key={tc.name} className={`border-b border-zinc-800/50 hover:bg-zinc-800/30 transition ${selectedTests.has(tc.name) ? 'bg-indigo-950/10' : ''}`}>
                      <td className="p-3 text-center">
                        <button onClick={() => toggleSelectTest(tc.name)} className={`hover:text-zinc-200 ${selectedTests.has(tc.name) ? 'text-indigo-400' : 'text-zinc-500'}`}>
                          {selectedTests.has(tc.name) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="p-3 font-mono text-zinc-300">{tc.name}</td>
                      {showContent && (
                        <td className="p-3 font-mono text-zinc-500 text-2xs truncate max-w-[200px]" title={tc.preview}>{tc.preview}</td>
                      )}
                      <td className="p-3 text-zinc-400 text-2xs">{formatSize(tc.size)}</td>
                      <td className="p-3 font-mono text-zinc-300">{tcTimeLimit.toFixed(3)}s</td>
                      {polyConfig.enableGroups && (
                        <td className="p-3 text-indigo-300 font-bold">{tconf.group || "-"}</td>
                      )}
                      <td className="p-3 text-right text-emerald-400 font-mono font-bold">{tconf.points}</td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button onClick={(e) => {
                            e.stopPropagation();
                            const rect = e.currentTarget.getBoundingClientRect();
                            setPopover({ type: 'points', testName: tc.name, x: rect.left - 150, y: rect.bottom + 4 });
                            setPopoverInput(tconf.points.toString());
                          }} className="text-zinc-500 hover:text-indigo-400 text-[10px] uppercase font-bold tracking-wider">Points</button>
                          <button onClick={(e) => {
                            e.stopPropagation();
                            const rect = e.currentTarget.getBoundingClientRect();
                            setPopover({ type: 'time', testName: tc.name, x: rect.left - 150, y: rect.bottom + 4 });
                            setPopoverInput(tconf.timeLimit !== undefined ? tconf.timeLimit.toString() : "1.0");
                          }} className="text-zinc-500 hover:text-indigo-400 text-[10px] uppercase font-bold tracking-wider">Time</button>
                          {polyConfig.enableGroups && (
                            <button onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setPopover({ type: 'group', testName: tc.name, x: rect.left - 150, y: rect.bottom + 4 });
                              setPopoverInput(tconf.group || "");
                            }} className="text-zinc-500 hover:text-indigo-400 text-[10px] uppercase font-bold tracking-wider">Group</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

          {/* Groups Policy & Dependencies */}
          {polyConfig.enableGroups && (
            <div className="mt-8">
              <h4 className="text-[11px] font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                <Layout className="w-4 h-4" /> Groups Policy & Dependencies
              </h4>
              <div className="border border-zinc-800 rounded-lg overflow-hidden bg-[#151518]">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-400 border-b border-zinc-800">
                      <th className="p-3 w-32">Name</th>
                      <th className="p-3 w-20 text-center">Tests</th>
                      <th className="p-3 w-24 text-center">Points</th>
                      <th className="p-3 w-48">Points Policy</th>
                      <th className="p-3">Dependencies</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(polyConfig.groups).length === 0 ? (
                      <tr><td colSpan={5} className="p-6 text-center text-zinc-500">No groups defined. Assign tests to a group first.</td></tr>
                    ) : (
                      Object.keys(polyConfig.groups).sort().map(gName => {
                        const gConf = polyConfig.groups[gName];
                        const gTests = (Object.values(polyConfig.tests) as any[]).filter(t => t.group === gName);
                        const gPoints = gTests.reduce((acc, t) => acc + (t.points || 0), 0);
                        
                        return (
                          <tr key={gName} className="border-b border-zinc-800/50">
                            <td className="p-3 font-bold text-indigo-400">{gName}</td>
                            <td className="p-3 text-center text-zinc-300 font-mono">{gTests.length}</td>
                            <td className="p-3 text-center text-emerald-400 font-mono">{gPoints}</td>
                            <td className="p-3">
                              <select 
                                value={gConf.policy}
                                onChange={e => {
                                  setPolyConfig(prev => ({
                                    ...prev, groups: { ...prev.groups, [gName]: { ...gConf, policy: e.target.value as any } }
                                  }));
                                }}
                                className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-zinc-200 text-xs w-full"
                              >
                                <option value="EACH_TEST">EACH_TEST</option>
                                <option value="COMPLETE_GROUP">COMPLETE_GROUP</option>
                              </select>
                            </td>
                            <td className="p-3">
                              <div className="flex flex-wrap gap-2 items-center">
                                {gConf.dependencies.map(dep => (
                                  <span key={dep} className="flex items-center gap-1 bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-2xs font-bold">
                                    {dep} <X className="w-3 h-3 cursor-pointer hover:text-rose-400" onClick={() => removeDependency(gName, dep)} />
                                  </span>
                                ))}
                                <select
                                  value=""
                                  onChange={e => e.target.value && addDependency(gName, e.target.value)}
                                  className="bg-transparent border border-zinc-700 rounded px-1 py-0.5 text-zinc-400 text-2xs w-24"
                                >
                                  <option value="">+ Add...</option>
                                  {Object.keys(polyConfig.groups).filter(d => d !== gName && !gConf.dependencies.includes(d)).map(d => (
                                    <option key={d} value={d}>{d}</option>
                                  ))}
                                </select>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-800 bg-[#121214] flex justify-end gap-3 z-10">
          <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-zinc-400 hover:text-zinc-200 transition">Cancel</button>
          <button onClick={handleSave} className="px-5 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 rounded shadow transition">
            Save Configuration
          </button>
        </div>

        {/* Popover */}
        {popover && (
          <div 
            className="fixed bg-[#1a1a1f] border border-zinc-700 shadow-2xl rounded-md p-3 z-50 flex flex-col gap-2 w-56"
            style={{ top: popover.y, left: popover.x }}
            onClick={e => e.stopPropagation()}
          >
            {popover.type === 'points' && (
              <>
                <label className="text-2xs font-bold text-zinc-400 uppercase">Set point for {popover.testName}</label>
                <input type="number" autoFocus value={popoverInput} onChange={e => setPopoverInput(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white" />
                <span className="text-[9px] text-zinc-500">Leave empty to set point to 1</span>
              </>
            )}
            {popover.type === 'time' && (
              <>
                <label className="text-2xs font-bold text-zinc-400 uppercase">Set time limit for {popover.testName} (s)</label>
                <input type="number" step="0.1" autoFocus value={popoverInput} onChange={e => setPopoverInput(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white font-mono" />
                <span className="text-[9px] text-zinc-500">e.g. 1.0 or 0.5. Leave empty to delete override.</span>
              </>
            )}
            {popover.type === 'group' && (
              <>
                <label className="text-2xs font-bold text-zinc-400 uppercase">Set group for {popover.testName}</label>
                <input type="text" autoFocus value={popoverInput} onChange={e => setPopoverInput(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white" />
                <span className="text-[9px] text-zinc-500">Leave empty to delete test from group</span>
              </>
            )}
            {popover.type === 'batchGroup' && (
              <>
                <label className="text-2xs font-bold text-zinc-400 uppercase">Set group for {selectedTests.size} tests</label>
                <input type="text" autoFocus value={popoverInput} onChange={e => setPopoverInput(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white" />
              </>
            )}
            {popover.type === 'batchTime' && (
              <>
                <label className="text-2xs font-bold text-zinc-400 uppercase">Set time limit for {selectedTests.size} tests (s)</label>
                <input type="number" step="0.1" autoFocus value={popoverInput} onChange={e => setPopoverInput(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white font-mono" />
                <span className="text-[9px] text-zinc-500">e.g. 1.0 or 0.5. Leave empty to delete override.</span>
              </>
            )}
            {popover.type === 'batchPoints' && (
              <>
                <label className="text-2xs font-bold text-zinc-400 uppercase">Total points for {selectedTests.size} tests</label>
                <input type="number" value={batchPointsTotal} onChange={e => {
                  setBatchPointsTotal(e.target.value);
                  const total = parseFloat(e.target.value);
                  if (!isNaN(total) && selectedTests.size > 0) {
                    setPopoverInput((total / selectedTests.size).toString());
                  }
                }} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-emerald-400 font-bold" />
                <label className="text-2xs font-bold text-zinc-400 uppercase mt-1">Set point for each test</label>
                <input type="number" value={popoverInput} onChange={e => {
                  setPopoverInput(e.target.value);
                  const pt = parseFloat(e.target.value);
                  if (!isNaN(pt) && selectedTests.size > 0) {
                    setBatchPointsTotal((pt * selectedTests.size).toString());
                  }
                }} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white" />
              </>
            )}
            <div className="flex justify-end gap-2 mt-2">
              <button onClick={() => setPopover(null)} className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-xs text-white">Cancel</button>
              <button onClick={savePopover} className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-xs text-white font-bold">Save</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
