export function shouldRegisterBrowserBeforeUnload(scope: object): boolean {
  return !("__TAURI_INTERNALS__" in scope);
}

export function isDesktopReloadShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">): boolean {
  return event.key === "F5"
    || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
}

export const BACKEND_STARTUP_TIMEOUT_MS = 15_000;

export async function fetchWithStartupRetry(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: {
    deadline: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    pause?: (milliseconds: number) => Promise<void>;
  },
): Promise<Response> {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const pause = options.pause || ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  while (true) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (init?.signal?.aborted || now() >= options.deadline) throw error;
      await pause(100);
    }
  }
}
