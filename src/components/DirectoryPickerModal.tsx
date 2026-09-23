import { useEffect, useState, type DragEvent } from "react";
import { FolderOpen, X } from "lucide-react";
import { selectDirectory } from "../platform/directory-picker";
import { useTranslation } from "react-i18next";

export type DirectoryKind = "tests" | "contestants";

interface Props {
  kind: DirectoryKind;
  path: string;
  onPathChange: (path: string) => void;
  onDropPath: (path: string) => void;
  onClose: () => void;
  onLoad: () => void;
  isDraggingExternal?: boolean;
}

export default function DirectoryPickerModal({
  kind,
  path,
  onPathChange,
  onDropPath,
  onClose,
  onLoad,
  isDraggingExternal = false,
}: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const { t } = useTranslation();

  const activeDragging = isDragging || isDraggingExternal;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    setPickerError(null);
    const file = event.dataTransfer.files[0] as
      (File & { path?: string }) | undefined;
    if (file?.path) {
      onPathChange(file.path);
      onDropPath(file.path);
    }
  };

  const browse = async () => {
    setPickerError(null);
    try {
      const selectedPath = await selectDirectory(path);
      if (selectedPath) onPathChange(selectedPath);
    } catch (error) {
      setPickerError(t("appErrors.directoryNotFound.reason", "Không thể mở hộp thoại chọn thư mục."));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div
        className="w-full max-w-lg bg-surface border border-surface-border rounded-lg shadow-lg overflow-hidden flex flex-col"
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setIsDragging(false);
        }}
        onDrop={handleDrop}
      >
        <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between bg-surface-elevated">
          <h3 className="text-sm font-bold text-text-primary uppercase tracking-wider">
            {kind === "tests"
              ? t("directoryPicker.selectTests")
              : t("directoryPicker.selectContestants")}
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary"
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-4 flex-1">
          <div className="flex gap-2">
            <input
              type="text"
              value={path}
              onChange={(event) => {
                setPickerError(null);
                onPathChange(event.target.value);
              }}
              placeholder={
                kind === "tests"
                  ? t("directoryPicker.testsPlaceholder")
                  : t("directoryPicker.contestantsPlaceholder")
              }
              className="flex-1 bg-input-bg text-xs text-text-primary p-2.5 rounded border border-surface-border focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition font-mono"
            />
            <button
              type="button"
              onClick={browse}
              className="px-4 py-2 bg-surface-elevated hover:bg-surface-hover text-text-primary text-xs font-semibold rounded border border-surface-border transition cursor-pointer"
            >
              {t("directoryPicker.browse")}
            </button>
          </div>

          {pickerError && (
            <div className="rounded border border-rose-500/40 bg-rose-50 dark:bg-rose-950/60 p-2.5 text-xs text-rose-700 dark:text-rose-300">
              {pickerError}
            </div>
          )}

          <div
            className={`border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center gap-2.5 transition-all duration-200 ${
              activeDragging
                ? "border-indigo-500 bg-indigo-500/10"
                : "border-surface-border-strong bg-surface hover:border-surface-border"
            }`}
          >
            <FolderOpen
              className={`w-9 h-9 transition-colors duration-200 ${
                activeDragging ? "text-indigo-500 dark:text-indigo-400" : "text-text-muted"
              }`}
            />
            <div className="text-center">
              <p
                className={`text-xs font-medium transition-colors ${
                  activeDragging ? "text-indigo-600 dark:text-indigo-400 font-bold" : "text-text-muted"
                }`}
              >
                {t("directoryPicker.dropTarget")}
              </p>
              <p className="text-[11px] text-text-muted/70 mt-0.5">
                {kind === "tests"
                  ? t("directoryPicker.dropTestsHint", "Thả thư mục chứa các bài thi và testcases vào đây")
                  : t("directoryPicker.dropContestantsHint", "Thả thư mục chứa mã nguồn của các thí sinh vào đây")}
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-surface-border bg-surface-elevated flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-surface-elevated hover:bg-surface-hover text-text-primary text-xs font-semibold rounded border border-surface-border transition cursor-pointer"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={onLoad}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded transition cursor-pointer"
          >
            {t("directoryPicker.load")}
          </button>
        </div>
      </div>
    </div>
  );
}
