import React from "react";
import { preferencesStorage } from "../preferences/storage.js";
import ToolchainManager from "./ToolchainManager.js";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/** First-run setup uses the same registry-driven surface as later management. */
export function ToolchainSetupModal({ isOpen, onClose }: Props) {
  if (!isOpen) return null;
  return (
    <ToolchainManager
      firstRun
      onClose={() => {
        preferencesStorage.setToolchainSetupCompleted();
        onClose();
      }}
    />
  );
}
