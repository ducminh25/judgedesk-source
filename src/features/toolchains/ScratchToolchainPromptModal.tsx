import React, { useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Layers,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { preferencesStorage } from "../preferences/storage.js";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onEnableScratch: () => Promise<void>;
  onSuccessToast: (message: string) => void;
}

export default function ScratchToolchainPromptModal({
  isOpen,
  onClose,
  onEnableScratch,
  onSuccessToast,
}: Props) {
  const { t } = useTranslation();
  const [isApplying, setIsApplying] = useState(false);

  if (!isOpen) return null;

  const handleEnable = async () => {
    setIsApplying(true);
    try {
      await onEnableScratch();
      preferencesStorage.setScratchPromptChoice("enabled");
      onSuccessToast(t("toolchains.scratchPrompt.successEnabled", {
        defaultValue: "Đã kích hoạt bộ chấm Scratch (.sb3, .sb2) thành công!",
      }));
      onClose();
    } catch (err) {
      console.error("Failed to enable Scratch toolchain:", err);
    } finally {
      setIsApplying(false);
    }
  };

  const handleDismiss = () => {
    preferencesStorage.setScratchPromptChoice("dismissed");
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scratch-prompt-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
    >
      <div className="bg-surface-elevated border border-surface-border w-full max-w-xl rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-surface-border flex items-start justify-between bg-surface-header/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3
                  id="scratch-prompt-title"
                  className="font-bold text-text-primary text-base"
                >
                  {t("toolchains.scratchPrompt.title", {
                    defaultValue: "Tính năng mới: Chấm bài thi Scratch",
                  })}
                </h3>
                <span className="text-[10px] uppercase font-bold bg-amber-500/20 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full">
                  v1.4.4
                </span>
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                {t("toolchains.scratchPrompt.subtitle", {
                  defaultValue: "Hỗ trợ chấm trực tiếp các bài thi Scratch (.sb3, .sb2) cho kỳ thi Tin học trẻ",
                })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={isApplying}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
            aria-label={t("common.close", { defaultValue: "Đóng" })}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-4">
          <div className="bg-surface-card border border-surface-border rounded-lg p-4 space-y-2.5">
            <h4 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <PackageCheck className="w-4 h-4 text-indigo-500" />
              {t("toolchains.scratchPrompt.featuresTitle", {
                defaultValue: "Các điểm nổi bật của Bộ chấm Scratch",
              })}
            </h4>
            <ul className="text-xs text-text-secondary space-y-2 list-disc list-inside">
              <li>
                <strong>{t("toolchains.scratchPrompt.featureFormats", { defaultValue: "Định dạng hỗ trợ:" })}</strong>{" "}
                Scratch 3.0 (.sb3), Scratch 2.0 (.sb2), .sb
              </li>
              <li>
                <strong>{t("toolchains.scratchPrompt.featureEngine", { defaultValue: "Engine thực thi:" })}</strong>{" "}
                Máy ảo Scratch Headless tốc độ cao (Turbo Mode)
              </li>
              <li>
                <strong>{t("toolchains.scratchPrompt.featureIO", { defaultValue: "Cơ chế vào ra:" })}</strong>{" "}
                Tự động nạp test từ <code>ask and wait</code> và thu thập kết quả từ <code>say / think</code>
              </li>
              <li>
                <strong>{t("toolchains.scratchPrompt.featurePlatform", { defaultValue: "Đa nền tảng:" })}</strong>{" "}
                Tương thích hoàn toàn 100% trên cả Windows và macOS
              </li>
            </ul>
          </div>

          <p className="text-xs text-text-muted">
            {t("toolchains.scratchPrompt.note", {
              defaultValue: "Bạn có thể thay đổi cấu hình hoặc kích hoạt lại ngôn ngữ Scratch bất cứ lúc nào trong Quản lý trình biên dịch (phím tắt F6).",
            })}
          </p>
        </div>

        {/* Actions Footer */}
        <div className="p-4 border-t border-surface-border bg-surface-header/30 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleDismiss}
            disabled={isApplying}
            className="px-4 py-2 text-xs font-semibold rounded-lg text-text-secondary hover:bg-surface-hover transition-colors"
          >
            {t("toolchains.scratchPrompt.dismissAction", {
              defaultValue: "Để sau",
            })}
          </button>
          <button
            type="button"
            onClick={handleEnable}
            disabled={isApplying}
            className="px-4 py-2 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white shadow transition-colors flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {isApplying
              ? t("toolchains.scratchPrompt.applying", { defaultValue: "Đang kích hoạt..." })
              : t("toolchains.scratchPrompt.confirmAction", { defaultValue: "Kích hoạt ngay" })}
          </button>
        </div>
      </div>
    </div>
  );
}
