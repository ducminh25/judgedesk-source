import {
  BACKEND_STARTUP_TIMEOUT_MS,
  fetchWithStartupRetry,
  resolveApiRetryDeadline,
} from "./features/desktop/browser-lifecycle.js";

export let API_BASE = "";
const API_SESSION_HEADER = "x-judgedesk-session";
let apiSessionToken: string | null = null;
let backendStartupDeadline = Date.now() + BACKEND_STARTUP_TIMEOUT_MS;

export interface BackendSession {
  port: number;
  token: string;
}

export function backendBaseUrlForPort(port: unknown): string {
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("JudgeDesk backend port is invalid.");
  }
  return `http://127.0.0.1:${port}`;
}

export function backendSessionFromIpc(value: unknown): BackendSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("JudgeDesk backend session is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || !("port" in record)
    || !("token" in record)
    || typeof record.port !== "number"
    || !Number.isSafeInteger(record.port)
    || record.port < 1
    || record.port > 65_535
    || typeof record.token !== "string"
    || !/^[0-9a-f]{64}$/.test(record.token)
  ) {
    throw new Error("JudgeDesk backend session is invalid.");
  }
  return { port: record.port, token: record.token };
}

export function authorizedApiHeaders(
  headers: HeadersInit | undefined,
  token: string,
): Headers {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error("JudgeDesk API session token is invalid.");
  }
  const authorized = new Headers(headers);
  authorized.set(API_SESSION_HEADER, token);
  return authorized;
}

export async function initializeApiPort() {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const session = backendSessionFromIpc(await invoke<unknown>("get_backend_session"));
    API_BASE = backendBaseUrlForPort(session.port);
    apiSessionToken = session.token;
    backendStartupDeadline = Date.now() + BACKEND_STARTUP_TIMEOUT_MS;
    console.log(`[API Init] Resolved backend port from Tauri: ${API_BASE}`);
  }
}

export async function apiFetch(path: string, init?: RequestInit) {
  const authorizedInit = apiSessionToken === null
    ? init
    : { ...init, headers: authorizedApiHeaders(init?.headers, apiSessionToken) };
  const response = await fetchWithStartupRetry(`${API_BASE}${path}`, authorizedInit, {
    deadline: resolveApiRetryDeadline(backendStartupDeadline),
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
