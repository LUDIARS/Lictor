/**
 * src/graceful-exit.ts — defer killing the wrapped AI process until it goes quiet.
 *
 * WHY: Concordia's session DELETE asks Lictor to force-exit the wrapped process.
 * If that kill lands while the AI is still finishing `session-end` (saving the
 * session log, updating memory), the save is truncated mid-write. So instead of
 * killing immediately, we WAIT: poll the transcript's last-write time and kill
 * only after it has been idle for `idleMs` (the AI has stopped producing output =
 * it's done writing the log). A `maxWaitMs` hard cap guarantees the process is
 * eventually reaped even if the transcript signal never settles.
 *
 * The activity signal is injected as `lastActivityMs()` (the transcript JSONL's
 * mtime, in wrap.ts) so this module is pure timer logic — no fs, fully testable
 * with injected clock/timer.
 *
 * SRP: scheduling + the idle/cap decision only. The kill action and the activity
 * source are the caller's.
 */

export interface GracefulExitOptions {
  /** Epoch-ms of the last transcript write, or null when unknown (no transcript yet). */
  lastActivityMs: () => number | null;
  /** Terminate the wrapped process (e.g. child.kill("SIGTERM")). Called at most once. */
  kill: () => void;
  /** Kill after this long with no transcript activity. Default 300_000 (5 min). */
  idleMs?: number;
  /** Hard cap from the request time; kill regardless of activity. Default 1_800_000 (30 min). */
  maxWaitMs?: number;
  /** Poll interval. Default 30_000 (30 s). */
  checkMs?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
  /** Injectable timer (tests). Default global setInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** Injectable timer clear (tests). Default global clearInterval. */
  clearIntervalFn?: (handle: unknown) => void;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface GracefulExitHandle {
  /** Cancel the pending deferred kill (the process exited on its own, etc.). */
  cancel: () => void;
  /** Run one idle/cap check immediately (exposed for tests). */
  tick: () => void;
}

/**
 * Schedule a deferred kill. Returns a handle; the kill fires from a timer once the
 * transcript has been idle `idleMs`, or unconditionally after `maxWaitMs`.
 */
export function scheduleGracefulExit(opts: GracefulExitOptions): GracefulExitHandle {
  const idleMs = opts.idleMs ?? 300_000;
  const maxWaitMs = opts.maxWaitMs ?? 1_800_000;
  const checkMs = opts.checkMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const log = opts.log ?? (() => {});

  const requestedAt = now();
  let killed = false;
  let handle: unknown = null;

  const stop = () => {
    if (handle !== null) {
      clearIntervalFn(handle);
      handle = null;
    }
  };

  const tick = () => {
    if (killed) return;
    const t = now();
    // Unknown activity → treat the request time as the baseline (don't wait forever
    // on a session that never produced a transcript).
    const lastAct = opts.lastActivityMs() ?? requestedAt;
    const idleFor = t - lastAct;
    const waitedFor = t - requestedAt;
    if (idleFor >= idleMs || waitedFor >= maxWaitMs) {
      killed = true;
      stop();
      const reason = idleFor >= idleMs ? `idle ${Math.round(idleFor / 1000)}s` : `max-wait ${Math.round(waitedFor / 1000)}s`;
      log(`graceful-exit: killing wrapped process (${reason})`);
      opts.kill();
    }
  };

  log(`graceful-exit: deferred kill armed (idle=${Math.round(idleMs / 1000)}s, max=${Math.round(maxWaitMs / 1000)}s)`);
  handle = setIntervalFn(tick, checkMs);
  // Don't let the timer keep the event loop alive on its own.
  (handle as { unref?: () => void })?.unref?.();

  return {
    cancel: () => { killed = true; stop(); },
    tick,
  };
}
