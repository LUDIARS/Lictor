/**
 * Deferred observation of self-processable permission requests.
 *
 * The PreToolUse hook blocks the wrapped session while it waits for the
 * sidecar, so the sidecar must never sleep before answering: nothing can
 * progress while the hook is held open. Instead the sidecar answers first
 * (delegating the decision back to Claude's own permission engine) and hands
 * the request to this observer, which looks at the transcript once the defer
 * window has elapsed:
 *
 *   - transcript advanced  -> the legacy auto-like mode handled the tool,
 *                             stay silent
 *   - transcript unchanged -> the TUI is asking a human and the session is
 *                             stalled, so notify Concordia
 *
 * Every armed observation is cancellable; `dispose()` is called when the
 * sidecar closes so a shutting-down session never posts afterwards.
 */

export interface DeferScheduler {
  /** Run `fn` after `ms`. Returns a cancel function that must be idempotent. */
  setTimer: (ms: number, fn: () => void) => () => void;
}

export interface PermissionTiming {
  deferMs: number;
  scheduler: DeferScheduler;
}

export interface TranscriptProgressSnapshot {
  path: string | null;
  totalLines: number;
  available: boolean;
}

export interface DeferredPermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: unknown;
}

export interface PermissionDeferObserverOptions {
  deferMs: number;
  scheduler: DeferScheduler;
  /** Reads the current transcript position, or null when unobservable. */
  readProgress: () => TranscriptProgressSnapshot | null;
  /** The session moved on by itself — no human notification is needed. */
  onProgressed: (request: DeferredPermissionRequest) => void;
  /** The session did not move — a human should be told about it. */
  onStalled: (request: DeferredPermissionRequest) => void;
}

interface ArmedObservation {
  cancel: (() => void) | null;
}

/**
 * A changed transcript path or additional JSONL line counts as progress.
 *
 * When either side is unobservable we deliberately report "no progress" so the
 * caller falls back to notifying a human: a redundant notice is recoverable,
 * a silently stalled session is not.
 */
export function transcriptProgressed(
  before: TranscriptProgressSnapshot | null,
  after: TranscriptProgressSnapshot | null,
): boolean {
  if (!before || !after) return false;
  if (!before.available || !after.available) return false;
  if (before.path !== after.path) return true;
  return after.totalLines > before.totalLines;
}

export class PermissionDeferObserver {
  private readonly options: PermissionDeferObserverOptions;
  private readonly armed = new Set<ArmedObservation>();
  private disposed = false;

  constructor(options: PermissionDeferObserverOptions) {
    this.options = options;
  }

  /** Number of observations still waiting for their defer window. */
  get pendingCount(): number {
    return this.armed.size;
  }

  /** The configured defer window, exposed for audit logging. */
  get deferMs(): number {
    return this.options.deferMs;
  }

  /**
   * Snapshot the transcript now and re-check it after the defer window.
   * Returns without arming anything once the observer has been disposed.
   */
  observe(request: DeferredPermissionRequest): void {
    if (this.disposed) return;

    const before = this.options.readProgress();
    const entry: ArmedObservation = { cancel: null };
    this.armed.add(entry);

    const fire = (): void => {
      this.armed.delete(entry);
      if (this.disposed) return;
      const after = this.options.readProgress();
      if (transcriptProgressed(before, after)) {
        this.options.onProgressed(request);
      } else {
        this.options.onStalled(request);
      }
    };

    entry.cancel = this.options.scheduler.setTimer(this.options.deferMs, fire);
  }

  /** Cancel every armed observation and refuse any further work. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.armed) {
      try {
        entry.cancel?.();
      } catch {
        // A failing cancel must not block the remaining cleanup.
      }
    }
    this.armed.clear();
  }
}

/** Real-time scheduler. Timers are unref'd so they never hold the process open. */
export function createRealScheduler(): DeferScheduler {
  return {
    setTimer: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      if (typeof timer.unref === "function") timer.unref();
      return () => clearTimeout(timer);
    },
  };
}
