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

  return (
    <div 
      className="fixed z-50 w-80 bg-surface border border-surface-border-strong shadow-2xl rounded-lg overflow-hidden flex flex-col select-none"
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
        <div className="text-text-muted text-xs font-mono">{formatTime(elapsed)}</div>
      </div>
      <div className="p-4 space-y-4">
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">{t("progress.target")}</span>
            <span className="text-text-primary font-bold">{currentContestant} - {currentProblem}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">{t("progress.action")}</span>
            <span className="text-indigo-600 dark:text-indigo-400 font-medium">{action}</span>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-text-muted font-mono">
            <span>{t("progress.progress")}</span>
            <span>{Math.round(percent)}%</span>
          </div>
          <div className="h-2 w-full bg-input-bg rounded-full overflow-hidden border border-surface-border">
            <div 
              className="h-full bg-indigo-500 transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
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
