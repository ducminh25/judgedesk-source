import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync, spawn, spawnSync } from "child_process";
import multer from "multer";
import AdmZip from "adm-zip";
import treeKill from "tree-kill";
import sea from "node:sea";

function isTextFile(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath);
    const checkLength = Math.min(buffer.length, 1024);
    for (let i = 0; i < checkLength; i++) {
      if (buffer[i] === 0) {
        return false;
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Production mode detection: when running as a pkg binary or Tauri sidecar
const IS_PRODUCTION = sea.isSea() || !!(process as any).pkg || process.env.NODE_ENV === "production";
const APP_ROOT = IS_PRODUCTION
  ? path.dirname(process.execPath) // Tauri sidecar: resolve relative to the exe
  : process.cwd();                 // Development: resolve relative to project root

const TEMP_ROOT = path.join(os.tmpdir(), "themis-v2");

let isolateBoxCounter = 0;
let sandboxMode: "wsl" | "docker" | "none" = "none";
let wslDistroName = "Ubuntu";
let wslMountPrefix = "/mnt";

function initSandbox() {
  let wslAvailable = false;
  let distroName = "Ubuntu";
  let mountPrefix = "/mnt";

  try {
    execSync("wsl -l", { stdio: "ignore", timeout: 3000 });
    wslAvailable = true;

    const listAscii = execSync("wsl -l -q", { encoding: "utf8", timeout: 3000 });
    const listUtf16 = execSync("wsl -l -q", { encoding: "utf16le", timeout: 3000 });
    const combined = listAscii + "\n" + listUtf16;

    if (combined.includes("Ubuntu")) {
      distroName = "Ubuntu";
    } else if (combined.includes("docker-desktop")) {
      distroName = "docker-desktop";
    }

    try {
      execSync(`wsl -d ${distroName} ls /mnt/host/c`, { stdio: "ignore", timeout: 3000 });
      mountPrefix = "/mnt/host";
    } catch (e) {
      mountPrefix = "/mnt";
    }
  } catch (e) {}

  let wslHasCompiler = false;
  let wslHasIsolate = false;
  if (wslAvailable) {
    try {
      execSync(`wsl -d ${distroName} g++ --version`, { stdio: "ignore", timeout: 3000 });
      wslHasCompiler = true;
    } catch (e) {}
    try {
      execSync(`wsl -d ${distroName} which isolate`, { stdio: "ignore", timeout: 3000 });
      wslHasIsolate = true;
    } catch (e) {}
  }

  let dockerAvailable = false;
  try {
    execSync("docker ps", { stdio: "ignore" });
    dockerAvailable = true;
  } catch (e) {}

  if (wslAvailable && wslHasCompiler && wslHasIsolate) {
    sandboxMode = "wsl";
    wslDistroName = distroName;
    wslMountPrefix = mountPrefix;
  } else if (dockerAvailable) {
    sandboxMode = "docker";
    wslMountPrefix = mountPrefix;
    
    // Start persistent Docker container
    try {
      execSync("docker rm -f local-judge-sandbox-run", { stdio: "ignore" });
    } catch (e) {}
    try {
      const mountArgs = [];
      const possibleDrives = ["c", "d", "e", "f", "g"];
      for (const drv of possibleDrives) {
         if (fs.existsSync(`${drv}:\\`)) {
            mountArgs.push("-v", `${drv}:/:${wslMountPrefix}/${drv}`);
         }
      }
      execSync(`docker run -d --privileged -m 1.5g --memory-swap 1.5g --name local-judge-sandbox-run ${mountArgs.join(" ")} local-judge-sandbox sleep infinity`, { stdio: "ignore" });
      console.log("[Sandbox Init] Started persistent Docker container: local-judge-sandbox-run");
    } catch (err: any) {
      console.error("[Sandbox Init] Failed to start Docker container:", err.message);
      sandboxMode = "none";
    }
  } else {
    sandboxMode = "none";
  }

  console.log(`[Sandbox Init] Sandbox Mode: ${sandboxMode}`);
  if (sandboxMode === "wsl") {
    console.log(`  WSL Distro: ${wslDistroName}, Mount Prefix: ${wslMountPrefix}`);
  }
}


// Cleanup persistent container on exit
process.on("exit", () => {
  if (sandboxMode === "docker") {
    try { execSync("docker rm -f local-judge-sandbox-run", { stdio: "ignore" }); } catch(e) {}
  }
});
process.on("SIGINT", () => {
  process.exit();
});
process.on("SIGTERM", () => {
  process.exit();
});

initSandbox();

function toSandboxPath(winPath: string): string {
  if (sandboxMode === "none") return winPath;
  const resolved = path.resolve(winPath).replace(/\\/g, "/");
  const driveMatch = resolved.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2];
    return `${wslMountPrefix}/${drive}/${rest}`;
  }
  return resolved;
}

function runSandboxCommand(cmdArgs: string[], options: { stdio?: any, cwd?: string, paths?: string[], encoding?: BufferEncoding } = {}) {
  if (sandboxMode === "wsl") {
    return spawnSync("wsl", ["-d", wslDistroName, ...cmdArgs], options);
  } else if (sandboxMode === "docker") {
    return spawnSync("docker", ["exec", "local-judge-sandbox-run", ...cmdArgs], options);
  } else {
    const cmd = cmdArgs[0];
    const rest = cmdArgs.slice(1);
    return spawnSync(cmd, rest, options);
  }
}

function spawnSandboxCommand(cmdArgs: string[], options: { stdio?: any, cwd?: string, timeout?: number, paths?: string[] } = {}) {
  if (sandboxMode === "wsl") {
    return spawn("wsl", ["-d", wslDistroName, ...cmdArgs], options);
  } else if (sandboxMode === "docker") {
    return spawn("docker", ["exec", "local-judge-sandbox-run", ...cmdArgs], options);
  } else {
    const cmd = cmdArgs[0];
    const rest = cmdArgs.slice(1);
    return spawn(cmd, rest, options);
  }
}

// Define TypeScript interfaces for our Judge
interface TestCaseRun {
  name: string;
  status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "FAIL" | "MLE" | "PARTIAL";
  peakMemory?: number;
  executionTime: number; // in ms
  score: number;
  checkerMessage?: string;
  inputPreview?: string;
  expectedOutputPreview?: string;
  actualOutputPreview?: string;
  errorDetail?: string;
}

interface ProblemResult {
  problemName: string;
  language: string;
  compileStatus: "OK" | "CE" | "SKIPPED";
  compileError?: string;
  compileTime?: number;
  testCases: TestCaseRun[];
  summary: {
    total: number;
    passed: number;
    score: number;
    maxScore: number;
    status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "FAIL" | "MLE" | "PENDING" | "PARTIAL";
  };
}

interface ContestantResult {
  contestantName: string;
  problems: ProblemResult[];
}

async function startServer() {
  const app = express();
  const activeJobs = new Map<string, { cancel: boolean, childProcess?: any }>();

  // Use JSON and URL encoded parsers
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  // CORS Middleware
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  app.post("/api/batch-judge/cancel", (req, res) => {
    const { jobId } = req.body;
    const job = activeJobs.get(jobId);
    if (job) {
      job.cancel = true;
      if (job.childProcess) {
        try {
          if (job.childProcess.pid) {
            treeKill(job.childProcess.pid, "SIGKILL");
          } else {
            job.childProcess.kill("SIGKILL");
          }
        } catch (e) {}
      }
      return res.json({ success: true });
    }
    res.json({ success: false, message: "Job not found" });
  });
  const PORT = 3000;

  // 1. Health check & Tool Presence status
  app.get("/api/status", (req, res) => {
    let hasGpp = false;
    let gppVersion = "";
    let hasPython = false;
    let pythonVersion = "";

    if (sandboxMode !== "none") {
      try {
        const resGpp = runSandboxCommand(["g++", "--version"], { encoding: "utf8" });
        gppVersion = resGpp.stdout ? resGpp.stdout.toString().split("\n")[0] : "Not found";
        hasGpp = gppVersion !== "Not found";
      } catch (e: any) {
        gppVersion = "Not found";
      }
      try {
        const resPy = runSandboxCommand(["python3", "--version"], { encoding: "utf8" });
        pythonVersion = resPy.stdout ? resPy.stdout.toString().split("\n")[0] : "Not found";
        hasPython = pythonVersion !== "Not found";
      } catch (e: any) {
        pythonVersion = "Not found";
      }
    } else {
      try {
        gppVersion = execSync("g++ --version", { encoding: "utf8" }).split("\n")[0];
        hasGpp = true;
      } catch (e: any) {
        gppVersion = e.message || "Not found";
      }
      try {
        pythonVersion = execSync("python3 --version", { encoding: "utf8" }).split("\n")[0];
        hasPython = true;
      } catch (e: any) {
        try {
          pythonVersion = execSync("python --version", { encoding: "utf8" }).split("\n")[0];
          hasPython = true;
        } catch (e2: any) {
          pythonVersion = "Not found";
        }
      }
    }

    res.json({
      gpp: { installed: hasGpp, version: gppVersion },
      python: { installed: hasPython, version: pythonVersion },
      isolate: { installed: sandboxMode !== "none" },
      tempDir: TEMP_ROOT,
      platform: os.platform(),
      isServerMode: sandboxMode !== "none"
    });
  });

  app.get("/api/select-directory", (req, res) => {
    try {
      const cmd = "powershell -STA -NoProfile -Command \"Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.AddExtension = $false; $f.CheckFileExists = $false; $f.DereferenceLinks = $true; $f.Filter = 'Folders|`n'; $f.Multiselect = $false; $f.Title = 'Select Folder'; $ft = $f.GetType(); $fNative = [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms').GetType('System.Windows.Forms.FileDialogNative+IFileDialog'); $iFd = $ft.GetMethod('CreateVistaDialog', [System.Reflection.BindingFlags]'NonPublic,Public,Static,Instance').Invoke($f, $null); [void]$ft.GetMethod('OnBeforeVistaDialog', [System.Reflection.BindingFlags]'NonPublic,Public,Static,Instance').Invoke($f, $iFd); [uint32]$pick = [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms').GetType('System.Windows.Forms.FileDialogNative+FOS').GetField('FOS_PICKFOLDERS').GetValue($null); $opts = $ft.GetMethod('get_Options', [System.Reflection.BindingFlags]'NonPublic,Public,Static,Instance').Invoke($f, $null) -bor $pick; [void]$fNative.GetMethod('SetOptions', [System.Reflection.BindingFlags]'NonPublic,Public,Static,Instance').Invoke($iFd, $opts); $o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; $o.Width = 0; $o.Height = 0; $o.Show(); $o.Hide(); $res = $f.ShowDialog($o); if ($res -eq 'OK') { Write-Output $f.FileName }; $o.Close()\"";
      const selectedPath = execSync(cmd, { encoding: "utf8" }).trim();
      console.log("[SelectDirectory] Modern path selected:", selectedPath);
      res.json({ success: true, path: selectedPath });
    } catch (err: any) {
      console.error("[SelectDirectory] Modern picker error:", err.message);
      res.json({ success: false, error: err.message });
    }
  });

  // Data Fetching & Natural Sorting Endpoints
  const naturalSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  app.get("/api/fetch-contestants", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, message: "Path required" });
    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
         return res.json({ success: true, data: [] });
      }
      const dirs = fs.readdirSync(resolved).filter(d => fs.statSync(path.join(resolved, d)).isDirectory());
      dirs.sort(naturalSort);
      res.json({ success: true, data: dirs });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/fetch-problems", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, message: "Path required" });
    try {
      const resolved = path.resolve(dirPath);
       if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
         return res.json({ success: true, data: [] });
      }
      const dirs = fs.readdirSync(resolved).filter(d => fs.statSync(path.join(resolved, d)).isDirectory());
      dirs.sort(naturalSort);

      const customCheckers: Record<string, string[]> = {};
      for (const d of dirs) {
        const probPath = path.join(resolved, d);
        const exeFiles: string[] = [];
        const cppFiles: string[] = [];
        try {
          if (fs.existsSync(probPath)) {
            const files = fs.readdirSync(probPath);
            for (const f of files) {
              if (fs.statSync(path.join(probPath, f)).isFile()) {
                const lf = f.toLowerCase();
                if (lf.startsWith("check") && lf.endsWith(".exe")) {
                  exeFiles.push(f);
                } else if (lf.endsWith(".cpp")) {
                  cppFiles.push(f);
                }
              }
            }
          }
        } catch (err) {}
        customCheckers[d] = [...exeFiles, ...cppFiles];
      }

      res.json({ success: true, data: dirs, customCheckers });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/fetch-tests", (req, res) => {
    const p = req.query.path as string;
    if (!p) return res.status(400).json({ success: false, message: "Path required" });
    try {
      const resolved = path.resolve(p);
       if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
         return res.json({ success: true, data: [] });
      }
      const dirs = fs.readdirSync(resolved).filter(d => fs.statSync(path.join(resolved, d)).isDirectory());
      dirs.sort(naturalSort);
      res.json({ success: true, data: dirs });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/fetch-polygon-tests", (req, res) => {
    const p = req.query.path as string;
    const problemName = req.query.problem as string;
    if (!p || !problemName) return res.status(400).json({ success: false, message: "Path and problem name required" });
    try {
      const resolved = path.resolve(p);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.json({ success: true, data: [] });
      }
      
      const dirs = fs.readdirSync(resolved).filter(d => fs.statSync(path.join(resolved, d)).isDirectory());
      dirs.sort(naturalSort);
      
      const result = dirs.map(d => {
        const testDirPath = path.join(resolved, d);
        let preview = "";
        let size = 0;
        
        // Find input file
        const possibleInps = [ `${problemName}.inp`, `${problemName.toLowerCase()}.inp`, `${problemName.toUpperCase()}.inp`, `${problemName}.in`, `${problemName.toLowerCase()}.in` ];
        let inpFile = "";
        for (const possible of possibleInps) {
          if (fs.existsSync(path.join(testDirPath, possible))) {
            inpFile = path.join(testDirPath, possible);
            break;
          }
        }
        
        if (inpFile) {
          const stats = fs.statSync(inpFile);
          size = stats.size;
          
          if (size > 0) {
            const fd = fs.openSync(inpFile, "r");
            const buf = Buffer.alloc(35);
            const bytesRead = fs.readSync(fd, buf, 0, 35, 0);
            fs.closeSync(fd);
            preview = buf.toString("utf8", 0, bytesRead).replace(/\r/g, "");
            if (size > 35) preview += "...";
          }
        }
        
        return { name: d, preview, size };
      });
      
      res.json({ success: true, data: result });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/polygon-config", (req, res) => {
    const p = req.query.path as string;
    if (!p) return res.status(400).json({ success: false, message: "Path required" });
    try {
      const configPath = path.join(path.resolve(p), "Config.cfg");
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, "utf8");
        return res.json({ success: true, data: JSON.parse(data) });
      }
      res.json({ success: true, data: null });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post("/api/polygon-config", (req, res) => {
    const p = req.body.path as string;
    const config = req.body.config;
    if (!p || !config) return res.status(400).json({ success: false, message: "Path and config required" });
    try {
      const configPath = path.join(path.resolve(p), "Config.cfg");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Batch Judge Endpoint
  app.post("/api/batch-judge", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    const { thisinhPath, testPath, timeLimit, jobId } = req.body;
    const sendEvent = (type: string, data: any) => {
      res.write(JSON.stringify({ type, data }) + "\n");
    };
    if (jobId) activeJobs.set(jobId, { cancel: false });
    const timeLimitInput = parseInt(timeLimit || "1000", 10);

    if (!thisinhPath || !testPath) {
      res.status(400).json({ success: false, message: "Missing thisinhPath or testPath." });
      return;
    }

    let resolvedThisinh, resolvedTest;
    try {
      resolvedThisinh = path.resolve(thisinhPath);
      resolvedTest = path.resolve(testPath);
      if (!fs.existsSync(resolvedThisinh) || !fs.statSync(resolvedThisinh).isDirectory()) {
        throw new Error(`Contestants directory not found: ${resolvedThisinh}`);
      }
      if (!fs.existsSync(resolvedTest) || !fs.statSync(resolvedTest).isDirectory()) {
        throw new Error(`Testcases directory not found: ${resolvedTest}`);
      }
    } catch (err: any) {
      res.write(JSON.stringify({ type: "error", data: { message: err.message } }) + "\n");
      res.end();
      return;
    }

    // Prepare temp space for compiling contestant solutions
    const runId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const tempDir = path.join(TEMP_ROOT, runId);
    fs.mkdirSync(tempDir, { recursive: true });

    if (sandboxMode === "none") {
      try {
        const gppVersion = execSync("g++ --version", { encoding: "utf8" });
      } catch (e) {
        res.status(400).json({ success: false, message: "g++ compiler is not available." });
        return;
      }
    } else {
      try {
        const resGpp = runSandboxCommand(["g++", "--version"], { encoding: "utf8", paths: [tempDir] });
        if (resGpp.status !== 0) throw new Error("g++ not available in sandbox");
      } catch (e) {
        res.status(400).json({ success: false, message: "g++ compiler is not available inside the sandbox." });
        return;
      }
    }

    let pythonCommand = "python";
    const possibleCmds = ["python3", "py", "python"];
    for (const cmd of possibleCmds) {
       try {
         require('child_process').execSync(`${cmd} --version`, { stdio: "ignore" });
         pythonCommand = cmd;
         break;
       } catch (e) {
         // ignore
       }
    }

    const testDirContent = fs.readdirSync(resolvedTest);
    const getTestProblemDirObj = (probName: string) => {
      const pLow = probName.toLowerCase();
      const match = testDirContent.find(d => d.toLowerCase() === pLow);
      if (match) {
        return { path: path.join(resolvedTest, match), name: match };
      }
      return null;
    };

    let contestantDirs = fs.readdirSync(resolvedThisinh).filter(d => fs.statSync(path.join(resolvedThisinh, d)).isDirectory());
    if (Array.isArray(req.body.targetContestants)) {
      contestantDirs = contestantDirs.filter((d: string) => req.body.targetContestants.includes(d));
    }
    const contestants: ContestantResult[] = [];

    // Map compiled checkers to avoid recompiling
    const compiledCheckers: Record<string, { path: string | null; error?: string }> = {};

    const targetProblems = Array.isArray(req.body.targetProblems) ? req.body.targetProblems : null;
    const totalProblemsCount = contestantDirs.length * (targetProblems ? targetProblems.length : 1);
    let completedProblemsCount = 0;

    for (const contestant of contestantDirs) {
      if (jobId && activeJobs.get(jobId)?.cancel) break;
      const contestantPath = path.join(resolvedThisinh, contestant);
      const problems: ProblemResult[] = [];
      const activeProblemsList = targetProblems || [];

      for (const targetProb of activeProblemsList) {
        if (jobId && activeJobs.get(jobId)?.cancel) break;
        sendEvent("progress", {
          contestant, problem: targetProb,
          action: "Locating submission...",
          percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
        });

        // Find file matching targetProb
        const subFiles = fs.readdirSync(contestantPath).filter(f => {
          const isFile = fs.statSync(path.join(contestantPath, f)).isFile();
          const ext = path.extname(f).toLowerCase();
          const base = path.basename(f, ext);
          return isFile && base.toLowerCase() === targetProb.toLowerCase() && (ext === ".cpp" || ext === ".py");
        });

        if (subFiles.length === 0) {
          problems.push({
            problemName: targetProb,
            language: "cpp",
            compileStatus: "SKIPPED",
            compileError: "not_found",
            testCases: [],
            summary: {
              total: 0,
              passed: 0,
              maxScore: 0,
              score: 0,
              status: "FAIL"
            }
          });
          completedProblemsCount++;
          continue;
        }

        const sub = subFiles[0];
        const problemName = path.basename(sub, path.extname(sub));
        const ext = path.extname(sub).toLowerCase();
        const language = ext === ".cpp" ? "cpp" : "python";
        
        const testProblemDir = getTestProblemDirObj(problemName);
        if (!testProblemDir) {
           problems.push({
             problemName: targetProb,
             language: "cpp",
             compileStatus: "SKIPPED",
             compileError: "not_found",
             testCases: [],
             summary: {
               total: 0,
               passed: 0,
               maxScore: 0,
               score: 0,
               status: "FAIL"
             }
           });
           completedProblemsCount++;
           continue;
        }

        sendEvent("progress", {
          contestant, problem: problemName,
          action: "Compiling...",
          percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
        });

        let probConf = req.body.problemConfigs?.[problemName] || { 
          useStdIn: false, 
          useStdOut: false, 
          inputFile: `${problemName}.inp`, 
          outputFile: `${problemName}.out`, 
          totalScore: null, 
          defaultScore: 1, 
          testScores: {}, 
          memoryLimit: 256, 
          checkerType: "C1" 
        };
        try {
          const cfgPath = path.join(testProblemDir.path, "Config.cfg");
          if (fs.existsSync(cfgPath)) {
             const loadedCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
             probConf = { 
               ...probConf, 
               polygonConfig: loadedCfg, 
               useStdIn: loadedCfg.useStdIn ?? loadedCfg.useStdIO ?? probConf.useStdIn ?? false,
               useStdOut: loadedCfg.useStdOut ?? loadedCfg.useStdIO ?? probConf.useStdOut ?? false,
               inputFile: loadedCfg.inputFile || probConf.inputFile || `${problemName}.inp`,
               outputFile: loadedCfg.outputFile || probConf.outputFile || `${problemName}.out`,
               memoryLimit: loadedCfg.memoryLimit ?? probConf.memoryLimit ?? 256,
               checkerType: loadedCfg.checkerType || probConf.checkerType 
             };
          } else {
             probConf = {
               ...probConf,
               useStdIn: probConf.useStdIn ?? false,
               useStdOut: probConf.useStdOut ?? false,
               inputFile: probConf.inputFile || `${problemName}.inp`,
               outputFile: probConf.outputFile || `${problemName}.out`,
               memoryLimit: probConf.memoryLimit ?? 256,
               checkerType: probConf.checkerType || "C1"
             };
          }
        } catch (e) {}
        const checkerType = probConf.checkerType || "C1";
        const useStdIn = probConf.useStdIn ?? probConf.useStdIO ?? false;
        const useStdOut = probConf.useStdOut ?? probConf.useStdIO ?? false;
        const inputFilename = useStdIn ? "stdin" : (probConf.inputFile || `${problemName}.inp`);
        const outputFilename = useStdOut ? "stdout" : (probConf.outputFile || `${problemName}.out`);

        // Deal with custom checker compilation / resolution
        const cacheKey = `${problemName}_${checkerType}`;
        if (!(cacheKey in compiledCheckers)) {
          if (["C1", "C2", "C3", "C4", "C5"].includes(checkerType)) {
            // Standard Checker: C#.exe from the global judgers directory
            const stdCheckerPath = path.join(APP_ROOT, "judgers", `${checkerType}.exe`);
            compiledCheckers[cacheKey] = { path: stdCheckerPath };
          } else if (checkerType.toLowerCase().endsWith(".cpp")) {
            // Custom cpp checker inside problem directory
            const checkerSrcPath = path.join(testProblemDir.path, checkerType);
            if (fs.existsSync(checkerSrcPath)) {
              const checkerBin = path.join(tempDir, `checker_${problemName}_${checkerType.replace(/\./g, "_")}.out`);
              try {
                if (sandboxMode !== "none") {
                  runSandboxCommand(["cp", toSandboxPath(checkerSrcPath), "/tmp/checker.cpp"]);
                  const compileRes = runSandboxCommand(["g++", "-std=c++14", "-O2", "/tmp/checker.cpp", "-o", "/tmp/checker.out"], { stdio: "ignore" });
                  if (compileRes.status !== 0) throw new Error("Checker compilation inside sandbox failed");
                  runSandboxCommand(["cp", "/tmp/checker.out", toSandboxPath(checkerBin)]);
                  runSandboxCommand(["rm", "-f", "/tmp/checker.cpp", "/tmp/checker.out"]);
                } else {
                  execSync(`g++ -std=c++14 -O2 "${checkerSrcPath}" -o "${checkerBin}"`, { stdio: "ignore" });
                }
                compiledCheckers[cacheKey] = { path: checkerBin };
              } catch (err: any) {
                compiledCheckers[cacheKey] = { path: null, error: err.message };
              }
            } else {
              compiledCheckers[cacheKey] = { path: null, error: `Custom checker ${checkerType} not found.` };
            }
          } else if (checkerType.toLowerCase().endsWith(".exe")) {
            // Custom exe checker inside problem directory
            const checkerExePath = path.join(testProblemDir.path, checkerType);
            if (fs.existsSync(checkerExePath)) {
              compiledCheckers[cacheKey] = { path: checkerExePath };
            } else {
              compiledCheckers[cacheKey] = { path: null, error: `Custom checker ${checkerType} not found.` };
            }
          } else {
            // Fallback to C1 if unknown
            const stdCheckerPath = path.join(APP_ROOT, "judgers", "C1.exe");
            compiledCheckers[cacheKey] = { path: stdCheckerPath };
          }
        }

        const subPath = path.join(contestantPath, sub);
        let executablePath = "";
        let compileError = "";
        let compileTime = 0;
        let compileStatus: "OK" | "CE" | "SKIPPED" = "OK";

        if (language === "cpp") {
          executablePath = path.join(tempDir, `${contestant}_${problemName}.out`);
          const compileStart = process.hrtime.bigint();
          try {
             if (sandboxMode !== "none") {
                 runSandboxCommand(["cp", toSandboxPath(subPath), "/tmp/compile.cpp"]);
                 const compileRes = runSandboxCommand([
                    "g++", "-std=c++14", "-pipe", "-O2", "-s", "-static", "-lm", "-x", "c++",
                    "/tmp/compile.cpp", "-o", "/tmp/compile.out"
                 ], { stdio: "pipe" });
                 if (compileRes.status !== 0) {
                    throw new Error(compileRes.stderr ? compileRes.stderr.toString() : "Compilation failed");
                 }
                 runSandboxCommand(["cp", "/tmp/compile.out", toSandboxPath(executablePath)]);
                 runSandboxCommand(["rm", "-f", "/tmp/compile.cpp", "/tmp/compile.out"]);
             } else {
                execSync(`g++ -std=c++14 -pipe -O2 -s -static -lm -x c++ -Wl,--stack,66060288 "${subPath}" -o "${executablePath}"`, {
                   cwd: tempDir,
                   stdio: "pipe"
                });
             }
             compileTime = Number(process.hrtime.bigint() - compileStart) / 1000000;
          } catch (err: any) {
             compileStatus = "CE";
             compileError = err.stderr ? err.stderr.toString() : err.message;
          }
        } else {
          executablePath = sandboxMode !== "none" ? "python3" : pythonCommand;
        }

        const tcRuns: TestCaseRun[] = [];
        let tcDirEntries = fs.readdirSync(testProblemDir.path).filter(d => fs.statSync(path.join(testProblemDir.path, d)).isDirectory());
        tcDirEntries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

         if (compileStatus === "OK") {
           let probConf = req.body.problemConfigs?.[problemName] || { useStdIO: false, defaultScore: 1, testScores: {} };
           
           // Load Config.cfg if exists (overrides probConf)
            try {
              const cfgPath = path.join(testProblemDir.path, "Config.cfg");
              if (fs.existsSync(cfgPath)) {
                 const parsedCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
                 probConf = { ...probConf, ...parsedCfg, polygonConfig: parsedCfg };
              }
            } catch (e) {}

           const isStdIO = !!probConf.useStdIO;
           const poly = probConf.polygonConfig;

           let totalWeight = 0;
           for (const tc of tcDirEntries) {
               let w = probConf.defaultScore !== undefined ? Number(probConf.defaultScore) : 1;
               if (poly && poly.tests && poly.tests[tc] && poly.tests[tc].points !== undefined) {
                   w = Number(poly.tests[tc].points);
               } else if (probConf.testScores && probConf.testScores[tc] !== undefined && probConf.testScores[tc] !== "") {
                   w = Number(probConf.testScores[tc]);
               }
               totalWeight += w;
           }

           for (let i = 0; i < tcDirEntries.length; i++) {
               const tcDir = tcDirEntries[i];
               if (jobId && activeJobs.get(jobId)?.cancel) break;
               sendEvent("progress", {
                 contestant, problem: problemName,
                 action: `Judging test ${i + 1} of ${tcDirEntries.length}`,
                 percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
               });
             const activeTcPath = path.join(testProblemDir.path, tcDir);
             const files = fs.readdirSync(activeTcPath);
             const inpFile = files.find(f => f.toLowerCase().endsWith(".inp") || f.toLowerCase().endsWith(".in"));
             const outFile = files.find(f => f.toLowerCase().endsWith(".out") || f.toLowerCase().endsWith(".ans"));

             if (!inpFile || !outFile) continue;

             const inpPath = path.join(activeTcPath, inpFile);
             const outPath = path.join(activeTcPath, outFile);
             const outputStringTarget = fs.readFileSync(outPath, "utf8");

             if (!isTextFile(inpPath)) {
               compileStatus = "CE";
               compileError = `Unreadable input file: ${inpFile}. Only text files are allowed.`;
               break;
             }

             // Determine the specific score for this test case
             let weightForTc: number = probConf.defaultScore !== undefined ? Number(probConf.defaultScore) : 1;
             if (poly && poly.tests && poly.tests[tcDir] && poly.tests[tcDir].points !== undefined) {
                 weightForTc = Number(poly.tests[tcDir].points);
             } else if (probConf.testScores && probConf.testScores[tcDir] !== undefined && probConf.testScores[tcDir] !== "") {
                 weightForTc = Number(probConf.testScores[tcDir]);
             }
             
             let scoreForTc = weightForTc;
             const totalScoreInput = probConf.totalScore;
             // Polygon config overrides proportional scoring
             if ((!poly || !poly.enableGroups) && totalScoreInput !== undefined && totalScoreInput !== null && totalScoreInput !== "") {
                 if (totalWeight > 0) {
                    scoreForTc = (weightForTc / totalWeight) * Number(totalScoreInput);
                 } else {
                    scoreForTc = 0;
                 }
                 scoreForTc = Math.round(scoreForTc * 10000) / 10000;
             }

             // Determine specific time limit for this test case
             let tcTimeLimitMs = timeLimitInput;
             if (poly && poly.tests && poly.tests[tcDir] && poly.tests[tcDir].timeLimit !== undefined) {
                 tcTimeLimitMs = Math.round(Number(poly.tests[tcDir].timeLimit) * 1000);
             }

             // Run contestant code
             const tcRes = await new Promise<TestCaseRun>((resolve) => {
               const startTime = process.hrtime.bigint();
               let childProcess;
               let isolateBox = -1;
               let isolateBoxDir = "";
               const memoryLimitKb = probConf.memoryLimit ? probConf.memoryLimit * 1024 : 0;
               let useIsolateForThisRun = sandboxMode !== "none";
               
               if (useIsolateForThisRun) {
                  isolateBox = (isolateBoxCounter++) % 100;
                  try {
                     const initRes = runSandboxCommand(["isolate", "-b", `${isolateBox}`, "--init"], { encoding: "utf8", paths: [tempDir] });
                     if (initRes.status !== 0) throw new Error("isolate init failed");
                     const boxPathOut = initRes.stdout.toString().trim();
                     isolateBoxDir = boxPathOut + "/box";
                     if (language === "cpp") {
                         runSandboxCommand(["cp", toSandboxPath(executablePath), `${isolateBoxDir}/exec`], { paths: [tempDir] });
                     } else {
                         runSandboxCommand(["cp", toSandboxPath(subPath), `${isolateBoxDir}/script.py`], { paths: [thisinhPath] });
                     }
                  } catch (e: any) {
                     console.error(`[Runner Isolate Init Error] Box: ${isolateBox}:`, e);
                     useIsolateForThisRun = false;
                  }
               }
               
               // Pre-execution file IO setup
               const inputFilename = probConf.inputFile || `${problemName}.inp`;
               if (!isStdIO) {
                  if (useIsolateForThisRun) {
                     try {
                        runSandboxCommand(["cp", toSandboxPath(inpPath), `${isolateBoxDir}/${inputFilename}`], { paths: [testPath] });
                     } catch(e: any) {}
                  } else {
                     try { fs.copyFileSync(inpPath, path.join(tempDir, inputFilename)); } catch(e) {}
                  }
               }

               if (useIsolateForThisRun) {
                  const metaWslPath = toSandboxPath(path.join(tempDir, `meta_${isolateBox}.txt`));
                  const isolateArgs = [
                     `-b`, `${isolateBox}`,
                     `--meta=${metaWslPath}`,
                     `--time=${(tcTimeLimitMs / 1000).toFixed(3)}`,
                     `--wall-time=${(tcTimeLimitMs / 1000 + 1).toFixed(3)}`,
                     `--processes=128`,
                  ];
                  if (useStdIn) {
                     isolateArgs.push(`--stdin=input.txt`);
                     try {
                        runSandboxCommand(["cp", toSandboxPath(inpPath), `${isolateBoxDir}/input.txt`], { paths: [testPath] });
                     } catch (e: any) {}
                  }
                  isolateArgs.push(`--stdout=output.txt`);
                  if (memoryLimitKb > 0) {
                      isolateArgs.push(`--cg`, `--cg-mem=${memoryLimitKb}`);
                  }
                  isolateArgs.push(`--run`, `--`);
                  if (language === "cpp") {
                     isolateArgs.push(`./exec`);
                  } else {
                     isolateArgs.push(`/usr/bin/python3`, `./script.py`);
                  }
                  childProcess = spawnSandboxCommand(["isolate", ...isolateArgs], { stdio: ["pipe", "pipe", "pipe"], timeout: tcTimeLimitMs, paths: [thisinhPath, testPath, tempDir] });
               } else if (os.platform() === "linux" && memoryLimitKb > 0) {
                  // Fallback to ulimit if Linux but no isolate
                  let cmd = "";
                  if (language === "cpp") {
                     cmd = `ulimit -v ${memoryLimitKb} && exec ./exec_target`;
                     fs.copyFileSync(executablePath, path.join(tempDir, "exec_target"));
                     fs.chmodSync(path.join(tempDir, "exec_target"), 0o755);
                  } else {
                     cmd = `ulimit -v ${memoryLimitKb} && exec python3 ./script.py`;
                     fs.copyFileSync(subPath, path.join(tempDir, "script.py"));
                  }
                  childProcess = spawn("bash", ["-c", cmd], { cwd: tempDir, stdio: ["pipe", "pipe", "pipe"], timeout: tcTimeLimitMs });
               } else {
                   const isWin = os.platform() === "win32";
                   const isMac = os.platform() === "darwin";
                   fs.mkdirSync(TEMP_ROOT, { recursive: true });

                   if (isWin) {
                      const sandboxExe = path.join(TEMP_ROOT, "student_bin.exe");
                      try { fs.rmSync(sandboxExe, { force: true }); } catch (e) {}
                      if (language === "cpp") {
                         fs.copyFileSync(executablePath, sandboxExe);
                         childProcess = spawn(sandboxExe, [], { cwd: tempDir, stdio: ["pipe", "pipe", "pipe"], timeout: tcTimeLimitMs });
                      } else {
                         let pythonExePath = "";
                         try {
                            pythonExePath = execSync(`where ${pythonCommand}`, { encoding: "utf8" }).split("\n")[0].trim();
                         } catch (e) {
                            pythonExePath = pythonCommand;
                         }
                         try { 
                            fs.copyFileSync(pythonExePath, sandboxExe); 
                            childProcess = spawn(sandboxExe, [subPath], { cwd: tempDir, stdio: ["pipe", "pipe", "pipe"], timeout: tcTimeLimitMs });
                         } catch (e) {
                            childProcess = spawn(pythonCommand, [subPath], { cwd: tempDir, stdio: ["pipe", "pipe", "pipe"], timeout: tcTimeLimitMs });
                         }
                      }
                   } else if (isMac) {
                      const sandboxBin = path.join(TEMP_ROOT, "student_bin");
                      try { fs.rmSync(sandboxBin, { force: true }); } catch (e) {}
                      
                      let resolvedBin = "";
                      let runArgs: string[] = [];
                      if (language === "cpp") {
                         fs.copyFileSync(executablePath, sandboxBin);
                         fs.chmodSync(sandboxBin, 0o755);
                         resolvedBin = sandboxBin;
                      } else {
                         let pythonBinPath = "";
                         try {
                            pythonBinPath = execSync(`which ${pythonCommand}`, { encoding: "utf8" }).trim();
                         } catch (e) {
                            pythonBinPath = "/usr/bin/python3";
                         }
                         try {
                            fs.copyFileSync(pythonBinPath, sandboxBin);
                            fs.chmodSync(sandboxBin, 0o755);
                            resolvedBin = sandboxBin;
                            runArgs = [subPath];
                         } catch (e) {
                            resolvedBin = pythonBinPath;
                            runArgs = [subPath];
                         }
                      }

                      const sbProfilePath = path.join(tempDir, "sandbox.sb");
                      const sbContent = `(version 1)
(deny default)
(allow process*)
(allow file-read* (subpath "/System/Library"))
(allow file-read* (subpath "/usr/lib"))
(allow file-read* (subpath "/lib"))
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "${testPath}"))
(allow file-read* (subpath "${thisinhPath}"))
(allow file-read* (subpath "${tempDir}"))
(allow file-read* (subpath "${TEMP_ROOT}"))
(allow file-write* (subpath "${tempDir}"))
(deny network*)`;
                      fs.writeFileSync(sbProfilePath, sbContent, "utf8");
                      childProcess = spawn("sandbox-exec", ["-f", sbProfilePath, resolvedBin, ...runArgs], {
                         cwd: tempDir,
                         stdio: ["pipe", "pipe", "pipe"],
                         timeout: tcTimeLimitMs
                      });
                   } else {
                      if (language === "cpp") {
                         childProcess = spawn(executablePath, [], { cwd: tempDir, stdio: ["pipe", "pipe", "pipe"], timeout: tcTimeLimitMs });
                      } else {
                         childProcess = spawn(executablePath, [subPath], { cwd: tempDir, stdio: ["pipe", "pipe", "pipe"], timeout: tcTimeLimitMs });
                      }
                   }
               }

               if (jobId) {
                  const job = activeJobs.get(jobId);
                  if (job && childProcess) job.childProcess = childProcess;
               }
               let stdoutData = "";
               let stderrData = "";
               let isTimedOut = false;

               const timeoutTimer = setTimeout(() => {
                 isTimedOut = true;
                 if (childProcess && childProcess.pid) {
                   try { treeKill(childProcess.pid, "SIGKILL"); } catch(e) {}
                 } else if (childProcess) {
                   try { childProcess.kill("SIGKILL"); } catch(e) {}
                 }
               }, tcTimeLimitMs);

               const MAX_OUTPUT_SIZE = 16 * 1024 * 1024; // 16 MB limit
               childProcess.stdout.on("data", (c) => {
                 if (stdoutData.length < MAX_OUTPUT_SIZE) {
                    stdoutData += c.toString();
                    if (stdoutData.length >= MAX_OUTPUT_SIZE) {
                       stdoutData = stdoutData.substring(0, MAX_OUTPUT_SIZE);
                       if (childProcess && childProcess.pid) {
                          try { treeKill(childProcess.pid, "SIGKILL"); } catch(e) {}
                       } else if (childProcess) {
                          try { childProcess.kill("SIGKILL"); } catch(e) {}
                       }
                    }
                 }
               });
               childProcess.stderr.on("data", (c) => {
                 if (stderrData.length < MAX_OUTPUT_SIZE) {
                    stderrData += c.toString();
                    if (stderrData.length >= MAX_OUTPUT_SIZE) {
                       stderrData = stderrData.substring(0, MAX_OUTPUT_SIZE);
                    }
                 }
               });

               // Prevent EPIPE crashes if the child process exits before stdin finishes writing
               childProcess.stdin.on("error", (err) => {
                 // Ignore EPIPE
               });

               if (useStdIn) {
                 const readStream = fs.createReadStream(inpPath);
                 readStream.on("error", (err) => {});
                 readStream.pipe(childProcess.stdin);
               } else {
                 childProcess.stdin.end();
               }

               childProcess.on("close", (code, signal) => {
                  clearTimeout(timeoutTimer);
                  const duration = Number(process.hrtime.bigint() - startTime) / 1000000;
                  let status: TestCaseRun["status"] = "AC";
                  let errDtl = "";

                  // Post-execution file IO resolution
                  if (useIsolateForThisRun) {
                     let outContent = "";
                     if (useStdOut) {
                        try {
                           const winOutPath = path.join(tempDir, `stdout_${isolateBox}.txt`);
                           const cpRes = runSandboxCommand(["cp", `${isolateBoxDir}/output.txt`, toSandboxPath(winOutPath)], { paths: [tempDir] });
                           if (cpRes.status !== 0) {
                              console.error(`[Runner StdIO copy failed] exit code: ${cpRes.status}, stderr: ${cpRes.stderr ? cpRes.stderr.toString() : "N/A"}`);
                           }
                           if (fs.existsSync(winOutPath)) {
                              outContent = fs.readFileSync(winOutPath, "utf8");
                              fs.rmSync(winOutPath, { force: true });
                           } else {
                              console.error(`[Runner StdIO winOutPath not found] winOutPath: ${winOutPath}`);
                           }
                        } catch (e: any) {
                           console.error(`[Runner StdIO Error]:`, e);
                        }
                     } else {
                        try {
                           const winOutPath = path.join(tempDir, outputFilename);
                           const cpRes = runSandboxCommand(["cp", `${isolateBoxDir}/${outputFilename}`, toSandboxPath(winOutPath)], { paths: [tempDir] });
                           if (cpRes.status === 0 && fs.existsSync(winOutPath)) {
                              outContent = fs.readFileSync(winOutPath, "utf8");
                           }
                        } catch (e: any) {
                           console.error(`[Runner FileIO Error] for ${outputFilename}:`, e);
                        }
                     }
                     stdoutData = outContent;
                  } else {
                    if (!useStdOut) {
                       let outContent = "";
                       const pPath = path.join(tempDir, outputFilename);
                       if (fs.existsSync(pPath)) {
                          outContent = fs.readFileSync(pPath, "utf8");
                       }
                       stdoutData = outContent || stdoutData; // fallback if missing
                    }
                 }

                 let peakMemoryKb = 0;
                 if (useIsolateForThisRun) {
                    try {
                       const metaFile = path.join(tempDir, `meta_${isolateBox}.txt`);
                       if (fs.existsSync(metaFile)) {
                          const metaStr = fs.readFileSync(metaFile, "utf8");
                          const matchMem = metaStr.match(/^max-rss:(\d+)/m) || metaStr.match(/^cg-mem:(\d+)/m);
                          if (matchMem) peakMemoryKb = parseInt(matchMem[1]);
                          if (metaStr.match(/^status:TO/m)) status = "TLE";
                          else if (metaStr.match(/^status:SG/m) || metaStr.match(/^status:RE/m)) status = "RE";
                       }
                       // Cleanup isolate box
                       runSandboxCommand(["isolate", "-b", `${isolateBox}`, "--cleanup"], { paths: [tempDir] });
                    } catch (e) {}
                 }

                 if (isTimedOut || signal === "SIGKILL" || status === "TLE") {
                   status = "TLE";
                 } else if (memoryLimitKb > 0 && peakMemoryKb > memoryLimitKb) {
                   status = "MLE";
                 } else if (code !== 0 && code !== null) {
                   // When using ulimit, memory allocation failures might lead to SIGSEGV (code 139) or SIGABRT (code 134) or exit code 127
                   if (code === 139 || code === 134 || stderrData.includes("MemoryError") || stderrData.includes("std::bad_alloc")) {
                      status = "MLE";
                   } else {
                      status = "RE";
                   }
                   errDtl = `Exit code ${code}. ${stderrData}`;
                 } else {
                    // Verification
                    const contestantTempOut = path.join(tempDir, `${contestant}_${problemName}_${tcDir}.out`);
                    fs.writeFileSync(contestantTempOut, stdoutData, "utf8");

                    const cacheKey = `${problemName}_${checkerType}`;
                    const checkerMeta = compiledCheckers[cacheKey];

                    // Direct JavaScript / Node.js implementation for standard checkers C1 - C5
                    if (["C1", "C2", "C3", "C4", "C5"].includes(checkerType)) {
                       let chkStatus: "AC" | "WA" | "PE" | "PARTIAL" = "AC";
                       let chkMessage = "";
                       
                       const ansText = outputStringTarget;
                       const outText = stdoutData;
                       
                       if (checkerType === "C1") {
                          const ansLines = ansText.split(/\r?\n/);
                          const outLines = outText.split(/\r?\n/);
                          while (ansLines.length > 0 && ansLines[ansLines.length - 1].trim() === "") ansLines.pop();
                          while (outLines.length > 0 && outLines[outLines.length - 1].trim() === "") outLines.pop();
                          
                          const splitWords = (line: string) => {
                             return line.split(/[ \t]+/).map(w => w.toLowerCase()).filter(Boolean);
                          };
                          
                          const maxLines = Math.max(ansLines.length, outLines.length);
                          chkStatus = "AC";
                          for (let i = 0; i < maxLines; i++) {
                             const aWords = splitWords(ansLines[i] || "");
                             const oWords = splitWords(outLines[i] || "");
                             if (aWords.length !== oWords.length || !aWords.every((w, idx) => w === oWords[idx])) {
                                chkStatus = "WA";
                                chkMessage = `Wrong answer at line ${i + 1}`;
                                break;
                             }
                          }
                       } else if (checkerType === "C2") {
                          const ansLines = ansText.split(/\r?\n/);
                          const outLines = outText.split(/\r?\n/);
                          while (ansLines.length > 0 && ansLines[ansLines.length - 1].trim() === "") ansLines.pop();
                          while (outLines.length > 0 && outLines[outLines.length - 1].trim() === "") outLines.pop();
                          
                          const splitWords = (line: string) => {
                             return line.split(/[ \t]+/).filter(Boolean);
                          };
                          
                          const maxLines = Math.max(ansLines.length, outLines.length);
                          chkStatus = "AC";
                          for (let i = 0; i < maxLines; i++) {
                             const aWords = splitWords(ansLines[i] || "");
                             const oWords = splitWords(outLines[i] || "");
                             if (aWords.length !== oWords.length || !aWords.every((w, idx) => w === oWords[idx])) {
                                chkStatus = "WA";
                                chkMessage = `Wrong answer at line ${i + 1}`;
                                break;
                             }
                          }
                       } else if (checkerType === "C3") {
                          const splitAllWords = (text: string) => {
                             return text.split(/[\s]+/).map(w => w.toLowerCase()).filter(Boolean);
                          };
                          const aWords = splitAllWords(ansText);
                          const oWords = splitAllWords(outText);
                          
                          if (aWords.length !== oWords.length) {
                             chkStatus = "WA";
                             chkMessage = `Wrong answer: different number of words (expected ${aWords.length}, found ${oWords.length})`;
                          } else {
                             chkStatus = "AC";
                             for (let i = 0; i < aWords.length; i++) {
                                if (aWords[i] !== oWords[i]) {
                                   chkStatus = "WA";
                                   chkMessage = `Wrong answer at word ${i + 1}`;
                                   break;
                                }
                             }
                          }
                       } else if (checkerType === "C4") {
                          const splitAllWords = (text: string) => {
                             return text.split(/[\s]+/).filter(Boolean);
                          };
                          const aWords = splitAllWords(ansText);
                          const oWords = splitAllWords(outText);
                          
                          if (aWords.length !== oWords.length) {
                             chkStatus = "WA";
                             chkMessage = `Wrong answer: different number of words (expected ${aWords.length}, found ${oWords.length})`;
                          } else {
                             chkStatus = "AC";
                             for (let i = 0; i < aWords.length; i++) {
                                if (aWords[i] !== oWords[i]) {
                                   chkStatus = "WA";
                                   chkMessage = `Wrong answer at word ${i + 1}`;
                                   break;
                                }
                             }
                          }
                       } else if (checkerType === "C5") {
                          if (ansText !== outText) {
                             chkStatus = "WA";
                             chkMessage = "Files are not identical";
                          } else {
                             chkStatus = "AC";
                             chkMessage = "ok";
                          }
                       }
                       
                       resolve({
                          name: tcDir,
                          status: chkStatus,
                          executionTime: Math.min(Math.round(duration), tcTimeLimitMs),
                          peakMemory: peakMemoryKb > 0 ? peakMemoryKb : undefined,
                          score: chkStatus === "AC" ? scoreForTc : 0,
                          checkerMessage: chkMessage || "ok",
                          errorDetail: errDtl,
                          expectedOutputPreview: outputStringTarget.substring(0, 500) + (outputStringTarget.length > 500 ? "..." : ""),
                          actualOutputPreview: stdoutData.substring(0, 500) + (stdoutData.length > 500 ? "..." : "")
                       });
                       return;
                    }

                    if (checkerMeta && checkerMeta.path && fs.existsSync(checkerMeta.path)) {
                        try {
                           let chkProcess;
                           if (sandboxMode !== "none") {
                              chkProcess = spawnSandboxCommand([
                                 toSandboxPath(checkerMeta.path),
                                 toSandboxPath(inpPath),
                                 toSandboxPath(contestantTempOut),
                                 toSandboxPath(outPath)
                              ], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000, paths: [testPath, tempDir] });
                           } else {
                              chkProcess = spawn(checkerMeta.path, [inpPath, contestantTempOut, outPath], { 
                                stdio: ["pipe", "pipe", "pipe"],
                                timeout: 5000 
                              });
                           }
                           
                           let chkOut = "";
                           let chkErr = "";
                           let chkTimedOut = false;
                           
                           const chkTimeoutTimer = setTimeout(() => {
                             chkTimedOut = true;
                             if (chkProcess.pid) {
                               try { treeKill(chkProcess.pid, "SIGKILL"); } catch(e) {}
                             }
                           }, 5000);
                           
                           chkProcess.stdout.on("data", d => chkOut += d.toString());
                           chkProcess.stderr.on("data", d => chkErr += d.toString());
                           
                           chkProcess.on("close", (chkCode, chkSignal) => {
                              clearTimeout(chkTimeoutTimer);
                              let calculatedScore = 0;
                              let checkerMsg = (chkOut + chkErr).trim();
                              
                              if (chkTimedOut || chkSignal === "SIGKILL" || chkCode === null) {
                                 status = "WA"; 
                                 calculatedScore = 0;
                              } else {
                                 // Handle testlib exit codes:
                                 if (chkCode === 0) {
                                    status = "AC";
                                    calculatedScore = scoreForTc;
                                 } else if (chkCode === 1) {
                                    status = "WA";
                                    calculatedScore = 0;
                                 } else if (chkCode === 2) {
                                    status = "PE";
                                    calculatedScore = 0;
                                 } else if (chkCode === 7) {
                                    status = "PARTIAL";
                                    
                                    // Try to parse partial score multiplier from stderr/stdout
                                    let parsedMult: number | null = null;
                                    const matchResult = checkerMsg.match(/result\s*=\s*([0-9.]+)/i) || 
                                                        checkerMsg.match(/points\s*([0-9.]+)/i) ||
                                                        checkerMsg.match(/score\s*:\s*([0-9.]+)/i);
                                    if (matchResult) {
                                       const val = parseFloat(matchResult[1]);
                                       if (!isNaN(val) && val >= 0.0) {
                                          parsedMult = val <= 1.0 ? val : val / scoreForTc;
                                       }
                                    }
                                    
                                    if (parsedMult === null) {
                                       const lines = chkOut.trim().split("\n").map(l => l.trim()).filter(Boolean);
                                       if (lines.length > 0) {
                                          const lastLine = lines[lines.length - 1];
                                          const val = parseFloat(lastLine);
                                          if (!isNaN(val) && val >= 0.0) {
                                             parsedMult = val <= 1.0 ? val : val / scoreForTc;
                                          }
                                       }
                                    }
                                    
                                    if (parsedMult !== null && parsedMult >= 0.0 && parsedMult <= 1.0) {
                                       calculatedScore = Math.round(parsedMult * scoreForTc * 10000) / 10000;
                                       if (parsedMult === 1.0) {
                                          status = "AC";
                                       } else if (parsedMult === 0.0) {
                                          status = "WA";
                                       }
                                    } else {
                                       calculatedScore = 0;
                                    }
                                 } else {
                                    status = "WA";
                                    calculatedScore = 0;
                                 }
                              }
                              
                              resolve({
                                name: tcDir,
                                status,
                                executionTime: Math.min(Math.round(duration), tcTimeLimitMs),
                                peakMemory: peakMemoryKb > 0 ? peakMemoryKb : undefined,
                                score: calculatedScore,
                                checkerMessage: checkerMsg,
                                errorDetail: errDtl,
                                expectedOutputPreview: outputStringTarget.substring(0, 500) + (outputStringTarget.length > 500 ? "..." : ""),
                                actualOutputPreview: stdoutData.substring(0, 500) + (stdoutData.length > 500 ? "..." : "")
                              });
                           });
                           return; // Do not resolve early
                        } catch (e: any) {
                           status = "FAIL";
                           errDtl = `Checker launch failed: ${e.message}`;
                        }
                    } else {
                       const c1 = stdoutData.replace(/\r\n/g, "\n").replace(/\s+$/g, "").trim();
                       const c2 = outputStringTarget.replace(/\r\n/g, "\n").replace(/\s+$/g, "").trim();
                       if (c1 !== c2) status = "WA";
                    }
                 }
                 
                 resolve({
                   name: tcDir,
                   status,
                   executionTime: Math.min(Math.round(duration), tcTimeLimitMs),
                   peakMemory: peakMemoryKb > 0 ? peakMemoryKb : undefined,
                   score: status === "AC" ? scoreForTc : 0,
                   errorDetail: errDtl,
                   expectedOutputPreview: outputStringTarget.substring(0, 500) + (outputStringTarget.length > 500 ? "..." : ""),
                   actualOutputPreview: stdoutData.substring(0, 500) + (stdoutData.length > 500 ? "..." : "")
                 });
               });

               childProcess.on("error", (e) => {
                  clearTimeout(timeoutTimer);
                  resolve({
                    name: tcDir, status: "RE", executionTime: 0, score: 0, errorDetail: e.message
                  });
               });
             });

             tcRuns.push(tcRes);
           }
        }

        let passedCt = tcRuns.filter(t => t.status === "AC").length;

         let probConfForPoly = req.body.problemConfigs?.[problemName] || { useStdIO: false, defaultScore: 1, testScores: {} };
         try {
           const testProblemDirTmp = getTestProblemDirObj(problemName);
           if (testProblemDirTmp) {
             const cfgPath = path.join(testProblemDirTmp.path, "Config.cfg");
             if (fs.existsSync(cfgPath)) {
                probConfForPoly = { ...probConfForPoly, polygonConfig: JSON.parse(fs.readFileSync(cfgPath, "utf8")) };
             }
           }
         } catch (e) {}
         
         const polyConf = probConfForPoly.polygonConfig;
         
         if (polyConf && polyConf.enableGroups && polyConf.groups && tcRuns.length > 0) {
             const groupResults: Record<string, any> = {};
             for (const [gName, gConf] of Object.entries(polyConf.groups)) {
                 const gTests = tcRuns.filter(t => polyConf.tests?.[t.name]?.group === gName);
                 const allAc = gTests.length > 0 && gTests.every(t => t.status === "AC");
                 groupResults[gName] = { allAc, tests: gTests, conf: gConf as any };
             }
             
             for (const [gName, gResult] of Object.entries(groupResults)) {
                 let depsPassed = true;
                 for (const dep of (gResult.conf.dependencies || [])) {
                     if (groupResults[dep] && !groupResults[dep].allAc) {
                         depsPassed = false;
                         break;
                     }
                 }
                 
                 gResult.tests.forEach((t: TestCaseRun) => {
                     if (!depsPassed) t.score = 0;
                     else if (gResult.conf.policy === "COMPLETE_GROUP" && !gResult.allAc) t.score = 0;
                 });
             }
         }

        let tScore = tcRuns.reduce((acc, t) => acc + t.score, 0);
        
        let pStatus: ProblemResult["summary"]["status"] = "AC";
        if (compileStatus === "CE") pStatus = "CE";
        else if (tcRuns.length > 0) {
           const fails = tcRuns.filter(t => t.status !== "AC");
           if (fails.length === tcRuns.length) {
               pStatus = fails[0].status; // ALL failed
           } else if (fails.length > 0) {
               pStatus = "PARTIAL"; // partially correct
           }
        }
        
        // Calculate max score based on config
        const probConf2 = probConfForPoly;
        let maxS = 0;
         if (polyConf && polyConf.enableGroups) {
             maxS = Object.values(polyConf.tests || {}).reduce((acc: any, t: any) => Number(acc) + (Number(t.points) || 0), 0) as number;
         } else
        if (probConf2.totalScore !== undefined && probConf2.totalScore !== null && probConf2.totalScore !== "") {
           maxS = Number(probConf2.totalScore);
           tScore = Math.round(tScore * 100) / 100; // Round total score for display
        } else {
           if (tcRuns.length > 0) {
               maxS = tcDirEntries.reduce((acc: number, tc: string) => {
                  let w = probConf2.defaultScore !== undefined ? Number(probConf2.defaultScore) : 1;
                  if (probConf2.testScores && probConf2.testScores[tc] !== undefined && probConf2.testScores[tc] !== "") {
                      w = Number(probConf2.testScores[tc]);
                  }
                  return acc + w;
               }, 0);
           }
           tScore = Math.round(tScore * 100) / 100;
        }

        const probResult = {
           problemName,
           language,
           compileStatus,
           compileError,
           compileTime,
           testCases: tcRuns,
           summary: {
             total: tcRuns.length,
             passed: passedCt,
             score: tScore,
             maxScore: maxS,
             status: pStatus
           }
        };
        if (jobId && activeJobs.get(jobId)?.cancel) break;
        problems.push(probResult);
        completedProblemsCount++;
        sendEvent("problem_completed", { contestant, problemResult: probResult });
      }

      if (problems.length > 0) {
        contestants.push({ contestantName: contestant, problems });
      }
    }

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch (e) {}

    if (jobId) activeJobs.delete(jobId);
    sendEvent("done", { success: true });
    res.end();
  });

  // Setup Vite development server or serve build files
  if (!IS_PRODUCTION) {
    const viteModule = "vite";
    const { createServer: createViteServer } = await import(viteModule);
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(APP_ROOT, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Online Judge Server] Live on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Critical: Failed to boot Online Judge server:", err);
});

