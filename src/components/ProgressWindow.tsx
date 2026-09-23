import React, { useEffect, useState, useRef } from "react";
import { X, Activity } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  currentContestant: string;
  currentProblem: string;
  action: string;
  percent: number;
  onTerminate: () => void;
}

export default function ProgressWindow({ currentContestant, currentProblem, action, percent, onTerminate }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const { t } = useTranslation();

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(prev => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only drag with left click on the handle
    if (e.button !== 0) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y };
    
    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      setPosition({
        x: ev.clientX - dragStart.current.x,
        y: ev.clientY - dragStart.current.y
      });
    };
    
    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const displayTarget = (currentContestant || currentProblem)
    ? `${currentContestant ? currentContestant : ""}${currentContestant && currentProblem ? " - " : ""}${currentProblem ? currentProblem : ""}`
    : t("progress.systemSetup");

  const formatAction = (act: string): string => {
    if (!act) return "";
    if (act.startsWith("progress.")) return t(act);
    if (act.includes("Initializing grading session")) return t("progress.initializing", "Đang khởi tạo phiên chấm...");
    if (act.includes("Verifying certified compiler") || act.includes("Verifying")) return t("progress.verifyingEnvironment", "Đang kiểm tra trình biên dịch & môi trường...");
    if (act.includes("Scanning submissions")) return t("progress.scanning", "Đang quét bài nộp và bộ test...");
    if (act.includes("Locating submission")) return t("progress.locating", "Đang tìm bài làm thí sinh...");
    if (act.startsWith("Compiling custom checker")) {
      const match = act.match(/\((.*?)\)/);
      return match
        ? `${t("progress.compilingChecker", "Đang biên dịch bộ chấm")} (${match[1]})...`
        : t("progress.compilingChecker", "Đang biên dịch bộ chấm (Checker)...");
    }
    if (act.startsWith("Compiling interactor")) {
      const match = act.match(/\((.*?)\)/);
      return match
        ? `${t("progress.compilingInteractor", "Đang biên dịch bộ tương tác")} (${match[1]})...`
        : t("progress.compilingInteractor", "Đang biên dịch bộ tương tác (Interactor)...");
    }
    if (act === "Compiling..." || act.startsWith("Compiling")) {
      return t("progress.compilingSubmission", "Đang biên dịch bài nộp...");
    }
    if (act.startsWith("Judging test ")) {
      const match = act.match(/Judging test (\d+) of (\d+)/i);
      if (match) {
        return t("progress.judgingTest", {
          current: match[1],
          total: match[2],
          defaultValue: `Đang chấm test ${match[1]} / ${match[2]}`,
        });
      }
    }
    return t(`progress.${act}`, { defaultValue: act });
  };

  const displayAction = formatAction(action);

  const isWarmupPhase = !currentContestant && !currentProblem;
  const isIndeterminate = isWarmupPhase || percent <= 0;
  const displayPercent = isWarmupPhase ? 0 : Math.max(0, Math.min(100, Math.round(percent)));

  return (
    <div 
      className="fixed z-50 w-80 bg-surface border border-surface-border-strong shadow-lg rounded-md overflow-hidden flex flex-col select-none"
      style={{
        top: '80px',
        right: '80px',
        transform: `translate(${position.x}px, ${position.y}px)`,
      }}
    >
      <div 
        onMouseDown={handleMouseDown}
        className="handle p-3 bg-surface-elevated border-b border-surface-border flex items-center justify-between cursor-move"
      >
        <h3 className="text-text-primary text-xs font-bold flex items-center gap-2 uppercase tracking-wider">
          <Activity className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
          {t("progress.batchGrading")}
        </h3>
        <div className="text-text-muted text-xs font-mono tabular-nums">{formatTime(elapsed)}</div>
      </div>
      <div className="p-4 space-y-4">
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">{t("progress.target")}</span>
            <span className="text-text-primary font-bold">{displayTarget}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">{t("progress.action")}</span>
            <span className="text-indigo-600 dark:text-indigo-400 font-medium">{displayAction}</span>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-text-muted font-mono tabular-nums">
            <span>{t("progress.progress")}</span>
            <span>{displayPercent}%</span>
          </div>
          <div className="h-2 w-full bg-input-bg rounded-sm overflow-hidden border border-surface-border relative">
            {isIndeterminate ? (
              <div className="h-full w-full bg-indigo-500/50 animate-pulse" />
            ) : (
              <div 
                className="h-full bg-indigo-500 transition-all duration-300"
                style={{ width: `${displayPercent}%` }}
              />
            )}
          </div>
        </div>
      </div>
      <div className="p-3 bg-surface-hover border-t border-surface-border flex justify-center">
        <button 
          onClick={onTerminate}
          className="w-full py-1.5 bg-rose-50 dark:bg-rose-600/20 hover:bg-rose-100 dark:hover:bg-rose-600/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-600/50 rounded text-xs font-bold tracking-wider uppercase transition"
        >
          {t("progress.terminate")}
        </button>
      </div>
    </div>
  );
}
