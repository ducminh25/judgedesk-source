import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseOsdFileName } from "./osd-parser.js";
import { writeOsdLog } from "./osd-log-writer.js";
import type { OsdJob } from "./osd-types.js";

export interface OsdWatcherOptions {
  osdPath: string;
  contestantsPath: string;
  getValidProblems: () => string[];
  onSubmissionIngested: (job: OsdJob, isNewContestant: boolean) => void;
  onError?: (error: Error | string) => void;
  enableLog?: boolean;
  pollIntervalMs?: number;
  debounceMs?: number;
  maxLockRetries?: number;
}

const IGNORED_NAMES = new Set(["logs", "rejected", "$history", ".ds_store", "thumbs.db"]);

export class OsdWatcher {
  private osdPath: string;
  private contestantsPath: string;
  private getValidProblems: () => string[];
  private onSubmissionIngested: (job: OsdJob, isNewContestant: boolean) => void;
  private onError?: (error: Error | string) => void;
  private enableLog: boolean;
  private pollIntervalMs: number;
  private debounceMs: number;
  private maxLockRetries: number;

  private active = false;
  private fsWatcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private processingFiles = new Set<string>();

  constructor(options: OsdWatcherOptions) {
    this.osdPath = path.resolve(options.osdPath);
    this.contestantsPath = path.resolve(options.contestantsPath);
    this.getValidProblems = options.getValidProblems;
    this.onSubmissionIngested = options.onSubmissionIngested;
    this.onError = options.onError;
    this.enableLog = options.enableLog !== false;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.debounceMs = options.debounceMs ?? 150;
    this.maxLockRetries = options.maxLockRetries ?? 5;
  }

  public get isActive(): boolean {
    return this.active;
  }

  public start(): void {
    if (this.active) return;
    if (!fs.existsSync(this.osdPath)) {
      fs.mkdirSync(this.osdPath, { recursive: true });
    }
    if (!fs.existsSync(this.contestantsPath)) {
      fs.mkdirSync(this.contestantsPath, { recursive: true });
    }

    this.active = true;

    try {
      this.fsWatcher = fs.watch(this.osdPath, (_eventType, fileName) => {
        if (!this.active || !fileName) return;
        void this.handleCandidate(fileName.toString());
      });
      this.fsWatcher.on("error", (err) => {
        this.onError?.(err);
      });
    } catch (err: any) {
      this.onError?.(`FSWatcher warning: ${err.message}. Relying on polling fallback.`);
    }

    this.pollTimer = setInterval(() => {
      if (!this.active) return;
      void this.scanDirectory();
    }, this.pollIntervalMs);

    // Initial scan
    void this.scanDirectory();
  }

  public stop(): void {
    this.active = false;
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignore close errors
      }
      this.fsWatcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.processingFiles.clear();
  }

  public async scanDirectory(): Promise<void> {
    if (!this.active || !fs.existsSync(this.osdPath)) return;
    try {
      const entries = fs.readdirSync(this.osdPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!this.active) break;
        if (entry.isFile() || (entry.isSymbolicLink() && fs.statSync(path.join(this.osdPath, entry.name)).isFile())) {
          await this.handleCandidate(entry.name);
        }
      }
    } catch (err: any) {
      this.onError?.(`Scan error: ${err.message}`);
    }
  }

  private async handleCandidate(fileName: string): Promise<void> {
    const lowerName = fileName.toLowerCase();
    if (IGNORED_NAMES.has(lowerName) || fileName.startsWith(".")) return;
    if (this.processingFiles.has(fileName)) return;

    const sourcePath = path.join(this.osdPath, fileName);
    if (!fs.existsSync(sourcePath)) return;

    try {
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) return;
    } catch {
      return;
    }

    this.processingFiles.add(fileName);

    try {
      await this.processSubmissionFile(fileName, sourcePath);
    } catch (err: any) {
      this.onError?.(`Error processing ${fileName}: ${err.message}`);
    } finally {
      this.processingFiles.delete(fileName);
    }
  }

  private async waitForFileStability(sourcePath: string): Promise<boolean> {
    let attempts = 0;
    let delayMs = this.debounceMs;

    while (attempts < this.maxLockRetries) {
      attempts++;
      if (!fs.existsSync(sourcePath)) return false;

      let fd: number | null = null;
      try {
        // Try opening read-write to verify no other process is actively writing/locking
        try {
          fd = fs.openSync(sourcePath, "r+");
        } catch {
          // If read-write fails, try read-only (for read-only file systems)
          fd = fs.openSync(sourcePath, "r");
        }

        const initialStat = fs.fstatSync(fd);
        fs.closeSync(fd);
        fd = null;

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        if (!fs.existsSync(sourcePath)) return false;
        const finalStat = fs.statSync(sourcePath);

        if (initialStat.size === finalStat.size && finalStat.size >= 0) {
          return true;
        }
      } catch (err: any) {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 1.5, 1000);
    }

    return fs.existsSync(sourcePath);
  }

  private async processSubmissionFile(fileName: string, sourcePath: string): Promise<void> {
    const isStable = await this.waitForFileStability(sourcePath);
    if (!isStable || !fs.existsSync(sourcePath)) return;

    const validProblems = this.getValidProblems();
    const parsed = parseOsdFileName(fileName, validProblems);

    if (!parsed.valid) {
      // Reject file
      const rejectedDir = path.join(this.osdPath, "Rejected");
      if (!fs.existsSync(rejectedDir)) {
        fs.mkdirSync(rejectedDir, { recursive: true });
      }
      const targetRejectedPath = path.join(rejectedDir, fileName);
      try {
        if (fs.existsSync(targetRejectedPath)) {
          fs.unlinkSync(targetRejectedPath);
        }
        fs.renameSync(sourcePath, targetRejectedPath);
      } catch {
        try {
          fs.copyFileSync(sourcePath, targetRejectedPath);
          fs.unlinkSync(sourcePath);
        } catch {
          // ignore
        }
      }

      if (this.enableLog) {
        writeOsdLog({
          osdPath: this.osdPath,
          originalFileName: fileName,
          errorReason: parsed.errorReason,
        });
      }
      return;
    }

    // Valid submission: move into Contestants/[contestant]/[problem].[ext]
    const contestantDir = path.join(this.contestantsPath, parsed.contestant);
    const isNewContestant = !fs.existsSync(contestantDir);
    if (isNewContestant) {
      fs.mkdirSync(contestantDir, { recursive: true });
    }

    // Check for existing submissions of the same problem to archive into $History/
    try {
      const existingEntries = fs.readdirSync(contestantDir, { withFileTypes: true });
      const targetProblemLower = parsed.problem.toLowerCase();
      for (const entry of existingEntries) {
        if (!entry.isFile() && !(entry.isSymbolicLink() && fs.statSync(path.join(contestantDir, entry.name)).isFile())) {
          continue;
        }
        const ext = path.extname(entry.name);
        const base = entry.name.slice(0, entry.name.length - ext.length);
        if (base.toLowerCase() === targetProblemLower) {
          const historyDir = path.join(contestantDir, "$History");
          if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
          }
          const timestamp = Date.now();
          const archivedName = `${timestamp}_${entry.name}`;
          const currentPath = path.join(contestantDir, entry.name);
          const historyPath = path.join(historyDir, archivedName);
          try {
            fs.renameSync(currentPath, historyPath);
          } catch {
            fs.copyFileSync(currentPath, historyPath);
            fs.unlinkSync(currentPath);
          }
        }
      }
    } catch (err: any) {
      this.onError?.(`History archive warning: ${err.message}`);
    }

    const finalSubmissionPath = path.join(contestantDir, `${parsed.problem}.${parsed.extension}`);
    try {
      if (fs.existsSync(finalSubmissionPath)) {
        fs.unlinkSync(finalSubmissionPath);
      }
      fs.renameSync(sourcePath, finalSubmissionPath);
    } catch {
      fs.copyFileSync(sourcePath, finalSubmissionPath);
      fs.unlinkSync(sourcePath);
    }

    const job: OsdJob = {
      id: `osd_${crypto.randomUUID()}`,
      filePath: finalSubmissionPath,
      originalFileName: fileName,
      contestant: parsed.contestant,
      problem: parsed.problem,
      language: parsed.language,
      arrivedAt: Date.now(),
      status: "queued",
    };

    this.onSubmissionIngested(job, isNewContestant);
  }
}
