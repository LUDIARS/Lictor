/** Coalesced, acknowledged delivery of the currently bound transcript path. */
export class TranscriptPathReport {
  private desired: string | null = null;
  private acknowledged: string | null = null;
  private pending = false;
  private stopped = false;
  private retryAt = 0;
  private retryMs = 1000;

  constructor(
    private readonly send: (path: string) => void | Promise<void>,
    private readonly diagnostic: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  offer(path: string): void {
    if (this.stopped) return;
    if (path !== this.desired) {
      this.desired = path;
      this.retryAt = 0;
      this.retryMs = 1000;
    }
    this.flush();
  }

  /** Called by the existing tail poll, including when no new bytes arrive. */
  flush(): void {
    if (this.stopped || this.pending || !this.desired || this.desired === this.acknowledged || this.now() < this.retryAt) return;
    const path = this.desired;
    this.pending = true;
    void Promise.resolve().then(() => {
      if (!this.stopped) return this.send(path);
    }).then(() => {
      this.acknowledged = path;
      this.retryAt = 0;
      this.retryMs = 1000;
    }, () => {
      // Coordinator outages must not stop tailing. Keep the latest desired path for retry.
      this.retryAt = this.now() + this.retryMs;
      this.retryMs = Math.min(30000, this.retryMs * 2);
      try {
        this.diagnostic("lictor: transcript path report failed; retry pending");
      } catch {
        // A closing stderr/diagnostic sink must not create an unhandled rejection.
      }
    }).finally(() => { this.pending = false; });
  }

  stop(): void {
    this.stopped = true;
  }
}
