import type { HostStatus } from "../../../shared/contracts.js";
import { hasRunningOperation, type ToolchainState } from "./useToolchains.js";

interface HostStatusRefreshOptions {
  loadToolchains(): Promise<ToolchainState>;
  loadHostStatus(): Promise<HostStatus>;
  onStatus(status: HostStatus | null): void;
  onError(error: unknown): void;
  schedule?: (run: () => Promise<void>) => () => void;
}

export function createHostStatusRefresh(options: HostStatusRefreshOptions) {
  const schedule = options.schedule ?? ((run: () => Promise<void>) => {
    const timer = window.setTimeout(() => void run(), 1000);
    return () => window.clearTimeout(timer);
  });
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let refreshAgain = false;
  let cancelTimer: (() => void) | null = null;

  function request(clearCurrent = true): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight) {
      refreshAgain = true;
      return inFlight;
    }
    cancelTimer?.();
    cancelTimer = null;
    if (clearCurrent) options.onStatus(null);
    // Defer loading until inFlight is assigned, including synchronous failures.
    inFlight = Promise.resolve().then(async () => {
      let pending = false;
      try {
        // The host snapshot follows the pending snapshot, not the reverse.
        const toolchains = await options.loadToolchains();
        pending = hasRunningOperation(toolchains);
        const status = await options.loadHostStatus();
        if (disposed) return;
        options.onStatus(status);
      } catch (error) {
        if (!disposed) options.onError(error);
      } finally {
        inFlight = null;
        const repeat = pending || refreshAgain;
        refreshAgain = false;
        if (!disposed && repeat) cancelTimer = schedule(() => request(false));
      }
    });
    return inFlight;
  }

  return {
    request,
    dispose() {
      disposed = true;
      refreshAgain = false;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
