import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseOsdFileName } from "./osd-parser.js";
import { writeOsdLog } from "./osd-log-writer.js";
import { ensureOsdDirectory, writeOsdFile } from "./osd-files.js";
import { claimOsdSource, type OsdSource } from "./osd-source.js";
import type { OsdJob } from "./osd-types.js";

export interface OsdWatcherOptions {
  osdPath: string;
  contestantsPath: string;
  getValidProblems: () => string[];
  /** The receiver owns the snapshot after this synchronous callback returns. */
  onSubmissionIngested: (job: OsdJob, isNewContestant: boolean, source: OsdSource) => void;
  onError?: (error: Error | string) => void;
  enableLog?: boolean;
  pollIntervalMs?: number;
  debounceMs?: number;
  maxLockRetries?: number;
}

const IGNORED_NAMES = new Set(["logs", "rejected", "$history", ".ds_store", "thumbs.db"]);

export class OsdWatcher {
  private readonly options: OsdWatcherOptions;
  private osdPath: string;
  private contestantsPath: string;
  private active = false;
  private generation = 0;
  private fsWatcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private processingFiles = new Map<string, Promise<void>>();

  constructor(options: OsdWatcherOptions) {
    this.options = options;
    this.osdPath = path.resolve(options.osdPath);
    this.contestantsPath = path.resolve(options.contestantsPath);
  }

  public get isActive(): boolean { return this.active; }
  public get hasPendingSubmissions(): boolean { return this.processingFiles.size > 0; }

  public start(): void {
    if (this.active) return;
    for (const root of [this.osdPath, this.contestantsPath]) {
      if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    }
    this.osdPath = ensureOsdDirectory(this.osdPath);
    this.contestantsPath = ensureOsdDirectory(this.contestantsPath);
    this.active = true;
    ++this.generation;
    try {
      this.fsWatcher = fs.watch(this.osdPath, (_event, fileName) => {
        if (this.active && fileName) void this.handleCandidate(fileName.toString());
      });
      this.fsWatcher.on("error", error => this.options.onError?.(error));
    } catch (error) {
      this.options.onError?.(`FSWatcher warning: ${String(error)}. Relying on polling fallback.`);
    }
    this.pollTimer = setInterval(() => { void this.scanDirectory(); }, this.options.pollIntervalMs ?? 2000);
    void this.scanDirectory();
  }

  public stop(): void {
    this.active = false;
    ++this.generation;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  public async scanDirectory(): Promise<void> {
    if (!this.active) return;
    try {
      ensureOsdDirectory(this.osdPath);
      for (const entry of fs.readdirSync(this.osdPath, { withFileTypes: true })) {
        if (!this.active) break;
        if (!entry.isDirectory()) await this.handleCandidate(entry.name);
      }
      await Promise.all(this.processingFiles.values());
    } catch (error) {
      this.options.onError?.(`Scan error: ${String(error)}`);
    }
  }

  private handleCandidate(fileName: string): Promise<void> {
    if (!this.active || IGNORED_NAMES.has(fileName.toLowerCase()) || fileName.startsWith(".")
      || /\.(tmp|part)$/i.test(fileName)) return Promise.resolve();
    const pending = this.processingFiles.get(fileName);
    if (pending) return pending;
    const generation = this.generation;
    const operation = this.processSubmissionFile(fileName, generation).catch(error => {
      this.options.onError?.(`Error processing ${fileName}: ${String(error)}`);
    }).finally(() => { this.processingFiles.delete(fileName); });
    this.processingFiles.set(fileName, operation);
    return operation;
  }

  private async processSubmissionFile(fileName: string, generation: number): Promise<void> {
    if (!fs.existsSync(path.join(this.osdPath, fileName))) return;
    const parsed = parseOsdFileName(fileName, this.options.getValidProblems());
    const source = await claimOsdSource(this.osdPath, fileName,
      parsed.valid ? `${parsed.problem}.${parsed.extension}` : "rejected.source", {
        debounceMs: this.options.debounceMs ?? 150,
        maxRetries: this.options.maxLockRetries ?? 5,
        isActive: () => this.active && this.generation === generation,
      });
    if (!source) return;
    let transferred = false;
    let preserved = false;
    try {
      source.assertIntegrity();
      if (!parsed.valid) {
        writeOsdFile(this.osdPath, ["Rejected"], fileName, { sourcePath: source.filePath });
        preserved = true;
        if (this.options.enableLog !== false) writeOsdLog({
          osdPath: this.osdPath, originalFileName: fileName, errorReason: parsed.errorReason,
        });
        return;
      }
      const exists = fs.existsSync(path.join(this.contestantsPath, parsed.contestant));
      if (exists && !fs.readdirSync(this.contestantsPath).includes(parsed.contestant)) {
        throw new Error("OSD_CONTESTANT_IDENTITY_ALIAS: tên thí sinh trùng thư mục với cách viết khác.");
      }
      const isNew = !exists;
      const directory = ensureOsdDirectory(this.contestantsPath, parsed.contestant);
      for (const name of fs.readdirSync(directory)) {
        const extension = path.extname(name);
        if (name.slice(0, name.length - extension.length).toLowerCase() !== parsed.problem.toLowerCase()) continue;
        const previous = path.join(directory, name);
        const metadata = fs.lstatSync(previous);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
          throw new Error("OSD_HISTORY_LINKED_OR_NOT_REGULAR");
        }
        writeOsdFile(this.contestantsPath, [parsed.contestant, "$History"], `${crypto.randomUUID()}_${name}`, { sourcePath: previous });
        fs.unlinkSync(previous);
      }
      writeOsdFile(this.contestantsPath, [parsed.contestant], `${parsed.problem}.${parsed.extension}`, { sourcePath: source.filePath });
      const job: OsdJob = {
        id: `osd_${crypto.randomUUID()}`, filePath: source.filePath, originalFileName: fileName,
        contestant: parsed.contestant, problem: parsed.problem, language: parsed.language,
        arrivedAt: Date.now(), status: "queued",
      };
      this.options.onSubmissionIngested(job, isNew, source);
      transferred = true;
    } finally {
      if (!transferred) {
        // Preserve failed admissions; never delete the current inbox pathname.
        if (!preserved) writeOsdFile(this.osdPath, ["Rejected"], `${crypto.randomUUID()}.source`, { sourcePath: source.filePath });
        source.dispose();
      }
    }
  }
}
