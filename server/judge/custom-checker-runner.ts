import { spawn } from "child_process";
import treeKill from "tree-kill";
import { sandbox } from "../sandbox.js";
import type { TestVerdict } from "../types.js";

export interface CustomCheckerResult {
  status: TestVerdict;
  score: number;
  message: string;
}

interface RunCustomCheckerOptions {
  checkerPath: string;
  inputPath: string;
  actualOutputPath: string;
  expectedOutputPath: string;
  testDirectory: string;
  tempDirectory: string;
  maxScore: number;
}

export function parsePartialScore(message: string, stdout: string, maxScore: number): number | null {
  const match = message.match(/result\s*=\s*([0-9.]+)/i)
    || message.match(/points\s*([0-9.]+)/i)
    || message.match(/score\s*:\s*([0-9.]+)/i);
  if (match) {
    const value = parseFloat(match[1]);
    if (!Number.isNaN(value) && value >= 0) return value <= 1 ? value : value / maxScore;
  }
  const lines = stdout.trim().split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const value = parseFloat(lines[lines.length - 1]);
  if (Number.isNaN(value) || value < 0) return null;
  return value <= 1 ? value : value / maxScore;
}

export function runCustomChecker(options: RunCustomCheckerOptions): Promise<CustomCheckerResult> {
  return new Promise(resolve => {
    const checker = sandbox.mode !== "none"
      ? sandbox.spawnCommand([
          sandbox.toPath(options.checkerPath),
          sandbox.toPath(options.inputPath),
          sandbox.toPath(options.actualOutputPath),
          sandbox.toPath(options.expectedOutputPath)
        ], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000, paths: [options.testDirectory, options.tempDirectory] })
      : spawn(options.checkerPath, [options.inputPath, options.actualOutputPath, options.expectedOutputPath], {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000
        });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (checker.pid) {
        try { treeKill(checker.pid, "SIGKILL"); } catch { /* Process already exited. */ }
      }
    }, 5000);
    checker.stdout.on("data", chunk => { stdout += chunk.toString(); });
    checker.stderr.on("data", chunk => { stderr += chunk.toString(); });
    checker.on("close", (code, signal) => {
      clearTimeout(timeout);
      const message = (stdout + stderr).trim();
      if (timedOut || signal === "SIGKILL" || code === null) {
        resolve({ status: "WA", score: 0, message });
        return;
      }
      if (code === 0) {
        resolve({ status: "AC", score: options.maxScore, message });
        return;
      }
      if (code === 1) {
        resolve({ status: "WA", score: 0, message });
        return;
      }
      if (code === 2) {
        resolve({ status: "PE", score: 0, message });
        return;
      }
      if (code !== 7) {
        resolve({ status: "WA", score: 0, message });
        return;
      }
      const multiplier = parsePartialScore(message, stdout, options.maxScore);
      if (multiplier === null || multiplier < 0 || multiplier > 1) {
        resolve({ status: "PARTIAL", score: 0, message });
        return;
      }
      const status = multiplier === 1 ? "AC" : multiplier === 0 ? "WA" : "PARTIAL";
      resolve({
        status,
        score: Math.round(multiplier * options.maxScore * 10000) / 10000,
        message
      });
    });
  });
}
