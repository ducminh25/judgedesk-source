import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { apiFetch } from "../api";

interface DirectoryPickerResponse {
  success?: boolean;
  path?: string;
  error?: string;
}

export async function selectDirectory(defaultPath?: string): Promise<string | null> {
  if (isTauri()) {
    return open({
      directory: true,
      multiple: false,
      title: "Select Folder",
      ...(defaultPath ? { defaultPath } : {})
    });
  }

  const response = await apiFetch("/api/select-directory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ defaultPath })
  });
  
  const data = await response.json() as DirectoryPickerResponse;
  if (!response.ok || !data.success) {
    if (data.error === "Canceled") return null; // Or handle cancellation better
    throw new Error(data.error || `Directory picker failed with HTTP ${response.status}.`);
  }

  return data.path || null;
}
