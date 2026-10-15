import type { Store } from "./storage.js";
import type { CallController } from "./call-controller.js";

export type RetentionOptions = { now?: () => number; automatic?: boolean; intervalMs?: number };

/** Local conversation-text retention; booking metadata and command tombstones survive. */
export class Retention {
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private started = false;
  private readonly now: () => number;
  constructor(private store: Store, private controller: CallController,
    private reportFailure: () => void, private options: RetentionOptions = {}) {
    this.now = options.now ?? Date.now;
  }
  start() {
    if (this.closed || this.started) return;
    this.sweep(); // Complete startup cleanup before either listener accepts requests.
    this.started = true;
    if (this.options.automatic !== false) {
      this.timer = setInterval(() => {
        try { this.sweep(); } catch { this.reportFailure(); }
      }, this.options.intervalMs ?? 60_000);
      this.timer.unref();
    }
  }
  sweep() {
    if (this.closed) return 0;
    const cutoff = new Date(this.now() - this.store.getSettings().transcriptRetentionDays * 86_400_000).toISOString();
    let deleted = 0;
    for (;;) {
      const ids = this.store.calls.expiredConversations(cutoff, 100);
      if (!ids.length) return deleted;
      for (const id of ids) {
        // The existing transaction purges replay, saves the empty snapshot and deletion event,
        // then notifies UI listeners. A failure rolls that entire attempt back for a later retry.
        this.controller.deleteConversation(id);
        deleted++;
      }
    }
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
}
