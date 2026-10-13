import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../api.js";
import { preferencesStorage } from "../preferences/storage.js";
import type {
  DetectedThemisToolchain,
  ManagedToolchainInfo,
} from "./ThemisToolchainPromptModal.js";
import type { ToolchainState } from "./useToolchains.js";

interface UseThemisPromptModalOptions {
  onRefreshHostStatus: () => void;
  showSuccessToast?: (msg: string) => void;
}

export function useThemisPromptModal({
  onRefreshHostStatus,
  showSuccessToast,
}: UseThemisPromptModalOptions) {
  const [showThemisPromptModal, setShowThemisPromptModal] = useState(false);
  const [themisDetectedToolchains, setThemisDetectedToolchains] = useState<
    DetectedThemisToolchain[]
  >([]);
  const [managedToolchainsInfo, setManagedToolchainsInfo] = useState<
    ManagedToolchainInfo[]
  >([]);

  useEffect(() => {
    if (preferencesStorage.hasThemisPromptChoice()) return;

    let isMounted = true;
    const checkThemisDetection = async () => {
      try {
        const response = await apiFetch("/api/toolchains");
        if (!response.ok) return;
        const data = (await response.json()) as ToolchainState;
        if (!isMounted) return;

        const detected: DetectedThemisToolchain[] = [];
        for (const profile of data.profiles || []) {
          const themisCandidate = profile.candidates?.find(
            (c) =>
              c.canonicalPath.toLowerCase().includes("themis") ||
              c.displayPath.toLowerCase().includes("themis"),
          );
          if (themisCandidate) {
            const langName =
              profile.kind === "cpp"
                ? "C++ (g++)"
                : profile.kind === "c"
                  ? "C (gcc)"
                  : profile.kind === "pascal"
                    ? "Pascal (fpc)"
                    : profile.kind === "python"
                      ? "Python"
                      : profile.kind === "java"
                        ? "Java (javac)"
                        : profile.displayNameKey || profile.kind;
            detected.push({
              profileId: profile.id,
              kind: profile.kind,
              name: langName,
              path: themisCandidate.canonicalPath,
              version:
                themisCandidate.version || profile.active?.version || undefined,
            });
          }
        }

        const managed: ManagedToolchainInfo[] = (data.profiles || [])
          .filter((p) =>
            ["cpp", "c", "pascal", "python", "java"].includes(p.kind),
          )
          .map((p) => {
            const langName =
              p.kind === "cpp"
                ? "C++ (g++)"
                : p.kind === "c"
                  ? "C (gcc)"
                  : p.kind === "pascal"
                    ? "Pascal (fpc)"
                    : p.kind === "python"
                      ? "Python"
                      : p.kind === "java"
                        ? "Java (javac)"
                        : p.displayNameKey || p.kind;
            const ver =
              p.managedPackage?.version ||
              (p.kind === "cpp" || p.kind === "c"
                ? "14.2.0"
                : p.kind === "pascal"
                  ? "3.2.2"
                  : p.kind === "python"
                    ? "3.12.0"
                    : "21.0.12");
            return {
              profileId: p.id,
              kind: p.kind,
              name: langName,
              version: ver,
            };
          });

        if (detected.length > 0 && isMounted) {
          setThemisDetectedToolchains(detected);
          setManagedToolchainsInfo(managed);
          setShowThemisPromptModal(true);
        }
      } catch (err) {
        console.warn("Failed to probe Themis toolchains:", err);
      }
    };

    void checkThemisDetection();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleApplyThemisAll = useCallback(async () => {
    for (const item of themisDetectedToolchains) {
      try {
        await apiFetch(
          `/api/toolchains/profiles/${encodeURIComponent(item.profileId)}/preference`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "local_path",
              localPath: item.path,
            }),
          },
        );
      } catch (err) {
        console.error(
          `Failed to set Themis toolchain for ${item.profileId}:`,
          err,
        );
      }
    }
    onRefreshHostStatus();
  }, [themisDetectedToolchains, onRefreshHostStatus]);

  const handleApplyManagedAll = useCallback(async () => {
    for (const item of managedToolchainsInfo) {
      try {
        await apiFetch(
          `/api/toolchains/profiles/${encodeURIComponent(item.profileId)}/preference`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "managed",
            }),
          },
        );
      } catch (err) {
        console.error(
          `Failed to set managed toolchain for ${item.profileId}:`,
          err,
        );
      }
    }
    onRefreshHostStatus();
  }, [managedToolchainsInfo, onRefreshHostStatus]);

  return {
    showThemisPromptModal,
    setShowThemisPromptModal,
    themisDetectedToolchains,
    managedToolchainsInfo,
    handleApplyThemisAll,
    handleApplyManagedAll,
  };
}
