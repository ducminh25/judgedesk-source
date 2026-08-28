import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../api.js";
import { preferencesStorage } from "../preferences/storage.js";
import type { ToolchainState } from "./useToolchains.js";

interface UseScratchPromptModalOptions {
  onRefreshHostStatus: () => void;
  showSuccessToast?: (msg: string) => void;
}

export function useScratchPromptModal({
  onRefreshHostStatus,
  showSuccessToast,
}: UseScratchPromptModalOptions) {
  const [showScratchPromptModal, setShowScratchPromptModal] = useState(false);

  useEffect(() => {
    // Only show once on upgrade to v1.4.4 if the prompt hasn't been answered yet
    if (preferencesStorage.hasScratchPromptChoice()) return;

    let isMounted = true;
    const checkToolchains = async () => {
      try {
        const response = await apiFetch("/api/toolchains");
        if (!response.ok) return;
        const data = (await response.json()) as ToolchainState;
        if (!isMounted) return;

        const scratchProfile = data.profiles?.find(
          (p) => p.kind === "scratch" || p.id?.includes("scratch"),
        );
        if (scratchProfile) {
          setShowScratchPromptModal(true);
        }
      } catch (err) {
        console.error("Failed to check Scratch toolchain availability:", err);
      }
    };

    void checkToolchains();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleEnableScratch = useCallback(async () => {
    try {
      const res = await apiFetch("/api/toolchains/profiles/scratch-turbowarp-v1/preference", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "managed" }),
      });
      if (res.ok) {
        onRefreshHostStatus();
      }
    } catch (err) {
      console.error("Failed to configure Scratch toolchain:", err);
    }
  }, [onRefreshHostStatus]);

  return {
    showScratchPromptModal,
    setShowScratchPromptModal,
    handleEnableScratch,
  };
}
