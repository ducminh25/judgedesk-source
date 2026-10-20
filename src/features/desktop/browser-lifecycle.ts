export function shouldRegisterBrowserBeforeUnload(scope: object): boolean {
  return !("__TAURI_INTERNALS__" in scope);
}

export function isDesktopReloadShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">): boolean {
  return event.key === "F5"
    || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
}

export const BACKEND_STARTUP_TIMEOUT_MS = 15_000;
export const BACKEND_TRANSIENT_RETRY_WINDOW_MS = 10_000;
export const BACKEND_MIN_TRANSIENT_RETRIES = 3;

export function resolveApiRetryDeadline(
  startupDeadline: number,
  now = Date.now(),
): number {
  return Math.max(startupDeadline, now + BACKEND_TRANSIENT_RETRY_WINDOW_MS);
}

export async function fetchWithStartupRetry(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: {
    deadline: number;
    minRetries?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    pause?: (milliseconds: number) => Promise<void>;
  },
): Promise<Response> {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const pause = options.pause || ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const minRetries = options.minRetries ?? (options.deadline > now() ? BACKEND_MIN_TRANSIENT_RETRIES : 0);
  let retries = 0;
  while (true) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (init?.signal?.aborted || (now() >= options.deadline && retries >= minRetries)) {
        throw error;
      }
      retries += 1;
      await pause(100);
    }
  }
}
