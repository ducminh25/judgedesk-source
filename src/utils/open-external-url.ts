import { invoke } from "@tauri-apps/api/core";

export async function openExternalUrl(url: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await invoke("open_external_url", { url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
