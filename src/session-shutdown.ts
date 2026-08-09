const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

// @implements spec/feature/session-shutdown.md

export interface ShutdownRequest {
  reason?: string;
  archive?: boolean;
}

export interface ShutdownDependencies {
  onStart?: () => void;
  unregister: () => Promise<void>;
  isCliAlive?: () => boolean;
  kill: () => Promise<void> | void;
  flush?: () => Promise<void>;
  archive: (reason: string) => Promise<string | null>;
  /**
   * Concordia へ session-end 完了を通知する (best-effort)。
   * cleanup より前・archive の後に呼ぶ。HTTP listener を閉じる前でなければ届かない。
   */
  reportSessionEndDone?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  scheduleExit: () => void;
  warn?: (message: string) => void;
  flushTimeoutMs?: number;
}

export interface ShutdownResult {
  ok: true;
  already?: true;
  archived?: string | null;
}

export type ShutdownResponder = (result: ShutdownResult) => Promise<void>;

/** Owns the ordered shutdown lifecycle and duplicate-request guard. */
export class SessionShutdown {
  private started = false;

  constructor(private readonly deps: ShutdownDependencies) {}

  async run(
    request: ShutdownRequest = {},
    respond?: ShutdownResponder,
  ): Promise<ShutdownResult> {
    if (this.started) {
      const repeated: ShutdownResult = { ok: true, already: true };
      await respond?.(repeated);
      return repeated;
    }
    this.started = true;
    this.deps.onStart?.();

    await this.bestEffort("Concordia unregister", this.deps.unregister);
    if (this.deps.isCliAlive?.() !== false) {
      await this.bestEffort("wrapped process termination", async () => {
        await this.deps.kill();
      });
    }
    const flush = this.deps.flush;
    if (flush) {
      await this.bestEffort("transcript flush", () => withTimeout(
        flush(),
        this.deps.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS,
      ));
    }

    let archived: string | null = null;
    if (request.archive !== false) {
      try {
        archived = await this.deps.archive(normalizeReason(request.reason));
      } catch (error) {
        this.warn("session archive", error);
      }
    }

    // 完了通知は「PID を止めてよい」の合図なので、kill / flush / archive の後に出す。
    // ここを skill の手順に任せていた間、自動 session-end では一度も送られず
    // 回収経路が塞がっていた (Concordia 2026-08-08 の残留 21 ツリー)。
    if (this.deps.reportSessionEndDone) {
      await this.bestEffort("session-end completion report", this.deps.reportSessionEndDone);
    }

    const result: ShutdownResult = { ok: true, archived };
    // sidecar route は response の finish/close を待つ responder を渡す。応答後なら
    // cleanup が HTTP listener を閉じても response を途中で切らない。
    await respond?.(result);
    if (this.deps.cleanup) {
      await this.bestEffort("session resource cleanup", this.deps.cleanup);
    }
    try {
      this.deps.scheduleExit();
    } catch (error) {
      this.warn("sidecar exit scheduling", error);
    }
    return result;
  }

  private async bestEffort(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.warn(label, error);
    }
  }

  private warn(label: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.deps.warn?.(`${label} failed: ${detail}`);
  }
}

export function parseShutdownRequest(value: unknown): ShutdownRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.reason !== undefined && typeof body.reason !== "string") return null;
  if (body.archive !== undefined && typeof body.archive !== "boolean") return null;
  return {
    reason: typeof body.reason === "string" ? body.reason : undefined,
    archive: typeof body.archive === "boolean" ? body.archive : undefined,
  };
}

function normalizeReason(value: string | undefined): string {
  const reason = value?.trim();
  return reason ? reason.slice(0, 200) : "session-end";
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
