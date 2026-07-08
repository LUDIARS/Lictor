/**
 * Watchdog for remote text injection. After provider.submitInject writes text
 * to the wrapped TUI, the injected text may remain in the input buffer without
 * being submitted. If transcript-tail does not observe a user frame in time,
 * the watchdog sends Enter and keeps retrying until that user frame appears.
 */

export interface SubmitWatchdog {
  /** Call immediately after submitInject. Re-arms the timer. */
  arm: () => void;
  /** Call when transcript-tail observes the submitted user message. */
  noteUserMessage: () => void;
  /** Cleanup timer state on shutdown. */
  stop: () => void;
}

export interface SubmitWatchdogOptions {
  /** Enter sink, normally ctx.ptyWriter. */
  write: (data: string) => void;
  /** Retry interval. Disabled when <= 0. */
  timeoutMs: number;
  /** Best-effort diagnostic log. */
  log?: (msg: string) => void;
}

export function createSubmitWatchdog(opts: SubmitWatchdogOptions): SubmitWatchdog {
  let timer: NodeJS.Timeout | null = null;
  let armed = false;

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    if (!armed || !(opts.timeoutMs > 0)) return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (!armed) return;
      opts.log?.(
        `submit watchdog: no user frame ${opts.timeoutMs}ms after inject; forcing Enter`,
      );
      try {
        opts.write("\r");
      } catch {
        /* best-effort - pty may already be gone. */
      }
      schedule();
    }, opts.timeoutMs);
    timer.unref?.();
  };

  return {
    arm: () => {
      if (!(opts.timeoutMs > 0)) return;
      armed = true;
      schedule();
    },
    noteUserMessage: () => {
      armed = false;
      clear();
    },
    stop: () => {
      armed = false;
      clear();
    },
  };
}
