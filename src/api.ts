import {
  BACKEND_STARTUP_TIMEOUT_MS,
  fetchWithStartupRetry,
} from "./features/desktop/browser-lifecycle.js";

const isLoopbackDevelopmentOrigin =
  typeof window !== "undefined"
  && (window.location.hostname === "localhost"
    || window.location.hostname === "127.0.0.1")
  && !(window as any).__TAURI_INTERNALS__;

export let API_BASE = isLoopbackDevelopmentOrigin
  ? ""
  : "http://127.0.0.1:3000";
let backendStartupDeadline = Date.now() + BACKEND_STARTUP_TIMEOUT_MS;

export async function initializeApiPort() {
  const isTauri = !!(window as any).__TAURI_INTERNALS__;
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const port = await invoke<number>("get_backend_port");
      API_BASE = `http://127.0.0.1:${port}`;
      backendStartupDeadline = Date.now() + BACKEND_STARTUP_TIMEOUT_MS;
      console.log(`[API Init] Resolved backend port from Tauri: ${API_BASE}`);
    } catch (error) {
      console.error("[API Init] Failed to resolve backend port from Tauri, using fallback:", error);
    }
  }
}

export async function apiFetch(path: string, init?: RequestInit) {
  const response = await fetchWithStartupRetry(`${API_BASE}${path}`, init, {
    deadline: backendStartupDeadline,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
    } catch {
      // Keep the HTTP fallback when the response is not JSON.
    }
    throw new Error(message);
  }
  return response;
}
