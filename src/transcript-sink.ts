import { z } from "zod";

const PersistResponseSchema = z.object({
  persisted: z.boolean(),
}).passthrough();

export interface TranscriptFrameInput {
  kind: string;
  payload: unknown;
}

export interface TranscriptPostResult {
  seq: number;
  persisted: boolean;
}

export interface TranscriptPostOptions {
  requirePersisted?: boolean;
}

export interface TranscriptFrameSink {
  post(
    kind: string,
    payload: unknown,
    options?: TranscriptPostOptions,
  ): Promise<TranscriptPostResult>;
  flush(): Promise<void>;
}

export type TranscriptSinkErrorCode =
  | "transcript_sink_closed"
  | "transcript_sink_overflow"
  | "transcript_sink_failed"
  | "transcript_http_error"
  | "transcript_protocol_error"
  | "transcript_not_persisted";

export class TranscriptSinkError extends Error {
  constructor(
    public readonly code: TranscriptSinkErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TranscriptSinkError";
  }
}

export interface OrderedTranscriptSinkOptions {
  baseUrl: string;
  sessionId: string;
  initialSeq?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  maxQueue?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface QueuedFrame extends TranscriptFrameInput {
  seq: number;
  requirePersisted: boolean;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 100;
const DEFAULT_MAX_QUEUE = 1_000;

/**
 * Serializes transcript delivery for one Lictor session. A permanent failure
 * poisons the sink so later frames cannot overtake the failed sequence number.
 */
export class OrderedTranscriptSink implements TranscriptFrameSink {
  private nextSeq: number;
  private pendingCount = 0;
  private closed = false;
  private failure: Error | null = null;
  private chain: Promise<void> = Promise.resolve();

  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly maxQueue: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OrderedTranscriptSinkOptions) {
    this.nextSeq = options.initialSeq ?? 0;
    this.timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxAttempts = positiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.retryBaseMs = positiveInt(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.maxQueue = positiveInt(options.maxQueue, DEFAULT_MAX_QUEUE);
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  post(
    kind: string,
    payload: unknown,
    options: TranscriptPostOptions = {},
  ): Promise<TranscriptPostResult> {
    if (this.closed) {
      return Promise.reject(new TranscriptSinkError(
        "transcript_sink_closed",
        "transcript sink is closed",
      ));
    }
    if (this.failure) {
      return Promise.reject(new TranscriptSinkError(
        "transcript_sink_failed",
        "transcript sink is unavailable after a permanent delivery failure",
        { cause: this.failure },
      ));
    }
    if (this.pendingCount >= this.maxQueue) {
      return Promise.reject(new TranscriptSinkError(
        "transcript_sink_overflow",
        `transcript queue limit exceeded (${this.maxQueue})`,
      ));
    }

    const frame: QueuedFrame = {
      seq: this.nextSeq++,
      kind,
      payload,
      requirePersisted: options.requirePersisted ?? false,
    };
    this.pendingCount++;

    const delivery = this.chain.then(async () => {
      if (this.failure) throw this.failure;
      return this.deliverWithRetry(frame);
    });
    this.chain = delivery.then(
      () => undefined,
      (error: unknown) => {
        this.failure = asError(error);
      },
    );

    return delivery.finally(() => {
      this.pendingCount--;
    });
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private async deliverWithRetry(frame: QueuedFrame): Promise<TranscriptPostResult> {
    let lastError: Error | null = null;
    // timeout / ネットワーク断で終わった attempt は「サーバに届いて永続化済みかも
    // しれない」不確定送信。後続 attempt が persisted:false (= サーバの
    // INSERT OR IGNORE が同 seq を重複扱い) を返した場合、この不確定送信が
    // 実は成功していた at-least-once の正常系なので、requirePersisted でも
    // 成功として扱う (2026-07-12: Concordia 停滞 → 2s timeout → 同 seq 再送 →
    // 重複応答で codex bootstrap が自殺した実障害の恒久対策)。
    let uncertainAttempts = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let result: TranscriptPostResult;
      try {
        result = await this.deliver(frame);
      } catch (error) {
        lastError = asError(error);
        if (isUncertainDelivery(lastError)) uncertainAttempts++;
        if (!isRetryable(lastError) || attempt === this.maxAttempts) break;
        await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
        continue;
      }
      if (frame.requirePersisted && !result.persisted) {
        if (uncertainAttempts > 0) {
          return { seq: frame.seq, persisted: true };
        }
        // 不確定送信ゼロで persisted:false = 本当に他の書き手と seq が衝突している。
        // ここで通すと binding の実体が別 frame という壊れ方になるので fail する。
        lastError = new TranscriptSinkError(
          "transcript_not_persisted",
          `transcript seq=${frame.seq} was not newly persisted`,
        );
        break;
      }
      return result;
    }
    throw new TranscriptSinkError(
      "transcript_sink_failed",
      `failed to persist transcript seq=${frame.seq} after ${this.maxAttempts} attempts`,
      { cause: lastError ?? undefined },
    );
  }

  private async deliver(frame: QueuedFrame): Promise<TranscriptPostResult> {
    const url = `${this.options.baseUrl}/v1/sessions/${encodeURIComponent(this.options.sessionId)}/transcript-frame`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: frame.seq, kind: frame.kind, payload: frame.payload }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new TranscriptSinkError(
        "transcript_http_error",
        `transcript POST failed for seq=${frame.seq}`,
        { cause: asError(error) },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new TranscriptSinkError(
        "transcript_http_error",
        `transcript POST returned HTTP ${response.status} for seq=${frame.seq}`,
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new TranscriptSinkError(
        "transcript_protocol_error",
        `transcript POST returned invalid JSON for seq=${frame.seq}`,
        { cause: asError(error) },
      );
    }
    const parsed = PersistResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TranscriptSinkError(
        "transcript_protocol_error",
        `transcript POST response omitted persisted for seq=${frame.seq}`,
      );
    }
    // requirePersisted の判定は deliverWithRetry 側 (再送文脈を知っている層) で行う。
    return { seq: frame.seq, persisted: parsed.data.persisted };
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryable(error: Error): boolean {
  if (!(error instanceof TranscriptSinkError)) return false;
  return error.code === "transcript_http_error";
}

/**
 * リクエストがサーバに到達して処理された可能性を否定できない失敗か。
 * timeout / ネットワーク断 (transcript_http_error) はレスポンスを受け取れなかった
 * だけで、サーバ側では永続化が完了していることがある。HTTP 4xx/5xx も同 code に
 * 畳まれているが、これらも「届いた上での失敗」なので同様に不確定として扱う。
 */
function isUncertainDelivery(error: Error): boolean {
  if (!(error instanceof TranscriptSinkError)) return false;
  return error.code === "transcript_http_error";
}
