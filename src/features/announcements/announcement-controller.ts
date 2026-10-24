import type { AnnouncementSnapshot } from "../../../shared/announcements.js";
import type { AnnouncementClient } from "./announcement-client.js";
import { acceptSnapshot, EMPTY_ANNOUNCEMENTS } from "./announcement-model.js";
interface ControllerState { snapshot: AnnouncementSnapshot; busy: boolean; error: string | null }
/** Owns request lifetime beyond React StrictMode subscriptions; never owns UI navigation. */
export class AnnouncementController {
  private state: ControllerState = { snapshot: EMPTY_ANNOUNCEMENTS, busy: false, error: null };
  private listeners = new Set<() => void>();
  private startPromise: Promise<void> | undefined;
  private requests = 0;
  constructor(private readonly client: Pick<AnnouncementClient, "snapshot" | "refresh">) {}
  getState = (): ControllerState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(update: Partial<ControllerState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  async mutate(operation: () => Promise<AnnouncementSnapshot>): Promise<boolean> {
    ++this.requests; this.publish({ busy: true, error: null });
    try {
      const incoming = await operation();
      this.publish({ snapshot: acceptSnapshot(this.state.snapshot, incoming) });
      return true;
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally { --this.requests; this.publish({ busy: this.requests > 0 }); }
  }
  start(): Promise<void> {
    this.startPromise ??= (async () => {
      if (await this.mutate(() => this.client.snapshot())) await this.mutate(() => this.client.refresh("session"));
    })();
    return this.startPromise;
  }
  refresh = async (): Promise<void> => { await this.mutate(() => this.client.refresh()); };
  refreshIfStale = (): void => {
    const checkedAt = this.state.snapshot.checkedAt;
    if (!this.state.busy && (!checkedAt || Date.now() - Date.parse(checkedAt) > 30 * 60 * 1000)) void this.mutate(() => this.client.refresh("stale"));
  };
  reportError = (error: unknown): void => this.publish({ error: error instanceof Error ? error.message : String(error) });
}
