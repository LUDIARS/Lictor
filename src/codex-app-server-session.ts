import { z } from "zod";
import {
  CodexAppServerClient,
  type CodexRpcNotification,
  type SpawnCodexAppServerOptions,
} from "./codex-app-server-client.js";
import {
  CodexEventFrameMapper,
  notificationThreadId,
  parseTurnCompletion,
  type CodexMappedFrame,
  type CodexTurnCompletion,
} from "./codex-event-frames.js";
import {
  bootstrapCodexSession,
  type CodexSessionIdentity,
} from "./codex-session-bootstrap.js";
import {
  OrderedTranscriptSink,
  type TranscriptFrameSink,
} from "./transcript-sink.js";

const TurnStartResponseSchema = z.object({
  turn: z.object({
    id: z.string().min(1),
    status: z.string(),
  }).passthrough(),
}).passthrough();

export interface CodexAppServerSession {
  client: CodexAppServerClient;
  sink: TranscriptFrameSink;
  identity: CodexSessionIdentity;
}

export interface StartCodexAppServerSessionOptions {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  concordiaBaseUrl?: string;
  lictorSessionId?: string;
  sink?: TranscriptFrameSink;
  lictorVersion: string;
  requestTimeoutMs?: number;
  transcriptTimeoutMs?: number;
  transcriptMaxAttempts?: number;
  transcriptRetryBaseMs?: number;
  transcriptMaxQueue?: number;
  onDiagnostic?: (message: string) => void;
  spawnProcess?: SpawnCodexAppServerOptions["spawnProcess"];
}

export interface RunCodexDelegationOptions {
  prompt: string;
  cwd: string;
  turnTimeoutMs?: number;
}

export type CodexDelegationErrorCode =
  | "codex_turn_start_failed"
  | "codex_turn_failed"
  | "codex_thread_mismatch"
  | "codex_turn_timeout";

export class CodexDelegationError extends Error {
  constructor(
    public readonly code: CodexDelegationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexDelegationError";
  }
}

const DEFAULT_TURN_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_DEFERRED_COMPLETIONS = 16;

export async function startCodexAppServerSession(
  options: StartCodexAppServerSessionOptions,
): Promise<CodexAppServerSession> {
  const sink = options.sink ?? createOrderedSink(options);
  const client = CodexAppServerClient.spawn({
    binary: options.binary,
    cwd: options.cwd,
    env: options.env,
    requestTimeoutMs: options.requestTimeoutMs,
    onDiagnostic: options.onDiagnostic,
    spawnProcess: options.spawnProcess,
  });
  try {
    const identity = await bootstrapCodexSession(client, sink, {
      cwd: options.cwd,
      clientVersion: options.lictorVersion,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    return { client, sink, identity };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function createOrderedSink(options: StartCodexAppServerSessionOptions): TranscriptFrameSink {
  if (!options.concordiaBaseUrl || !options.lictorSessionId) {
    throw new Error("concordiaBaseUrl and lictorSessionId are required without an injected sink");
  }
  return new OrderedTranscriptSink({
    baseUrl: options.concordiaBaseUrl,
    sessionId: options.lictorSessionId,
    timeoutMs: options.transcriptTimeoutMs,
    maxAttempts: options.transcriptMaxAttempts,
    retryBaseMs: options.transcriptRetryBaseMs,
    maxQueue: options.transcriptMaxQueue,
  });
}

export async function runCodexDelegationTurn(
  session: CodexAppServerSession,
  options: RunCodexDelegationOptions,
): Promise<void> {
  const mapper = new CodexEventFrameMapper(session.identity.threadId);
  // turn/start の応答を待つ間に届いた完了通知は、まだ自分のターン id を知らないので
  // 誰のものか判定できない。 判定できないまま採用すると、 直前のターンが割り込みで
  // 中断された `turn_aborted` を自分のターンの結果として受け取り、 モデルを呼ぶ前に
  // 委託が死ぬ (Memoria #1355: 投入 332ms 後に turn_aborted(interrupted))。
  // id が分かるまで保留し、 分かってから照合する。
  let activeTurnId: string | null = null;
  const deferredCompletions: Array<{
    completion: CodexTurnCompletion;
    frame: CodexMappedFrame | null;
  }> = [];
  let deferredCompletionsOverflowed = false;
  let settled = false;
  let resolveCompletion: (() => void) | null = null;
  let rejectCompletion: ((error: Error) => void) | null = null;
  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const settleCompletion = (
    completion: CodexTurnCompletion,
    framePost: Promise<unknown>,
  ): void => {
    void framePost
      .then(() => session.sink.flush())
      .then(() => {
        if (settled) return;
        settled = true;
        if (completion.status === "completed") {
          resolveCompletion?.();
          return;
        }
        rejectCompletion?.(new CodexDelegationError(
          "codex_turn_failed",
          `Codex delegation ended with status=${completion.status}${
            completion.errorMessage ? `: ${completion.errorMessage}` : ""
          }`,
        ));
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        rejectCompletion?.(asError(error));
      });
  };

  const handleNotification = (notification: CodexRpcNotification): void => {
    if (settled) return;
    const observedThreadId = notificationThreadId(notification);
    if (observedThreadId && observedThreadId !== session.identity.threadId) {
      settled = true;
      rejectCompletion?.(new CodexDelegationError(
        "codex_thread_mismatch",
        `received ${notification.method} for an unexpected Codex thread`,
      ));
      return;
    }

    const completion = parseTurnCompletion(notification, session.identity.threadId);
    // 自分のターン id がまだ分からない = 誰の完了か判定できない。 保留する。
    if (completion && activeTurnId === null) {
      if (deferredCompletions.length >= MAX_DEFERRED_COMPLETIONS) {
        deferredCompletions.length = 0;
        deferredCompletionsOverflowed = true;
        return;
      }
      if (!deferredCompletionsOverflowed) {
        deferredCompletions.push({ completion, frame: mapper.map(notification) });
      }
      return;
    }
    // 別ターンの完了は自分の結果ではない。 割り込まれた前のターンの後始末なので、
    // 自分のターンの完了を待ち続ける (ここで失敗にすると他人の中断で委託が死ぬ)。
    if (completion && completion.turnId !== activeTurnId) return;

    const frame = mapper.map(notification);
    const framePost = frame
      ? session.sink.post(frame.kind, frame.payload)
      : Promise.resolve(null);
    if (completion) {
      settleCompletion(completion, framePost);
      return;
    }
    void framePost.catch((error: unknown) => {
      if (settled) return;
      settled = true;
      rejectCompletion?.(asError(error));
    });
  };

  const unsubscribe = session.client.onNotification(handleNotification);

  try {
    let turnRaw: unknown;
    try {
      turnRaw = await session.client.request("turn/start", {
        threadId: session.identity.threadId,
        input: [{ type: "text", text: options.prompt }],
        cwd: options.cwd,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [options.cwd],
          networkAccess: false,
        },
      });
    } catch (error) {
      throw new CodexDelegationError(
        "codex_turn_start_failed",
        "Codex delegation turn/start failed",
        { cause: asError(error) },
      );
    }
    const turnResult = TurnStartResponseSchema.safeParse(turnRaw);
    if (!turnResult.success) {
      throw new CodexDelegationError(
        "codex_turn_start_failed",
        "Codex turn/start response omitted the turn id",
      );
    }
    activeTurnId = turnResult.data.turn.id;
    if (deferredCompletionsOverflowed) {
      throw new CodexDelegationError(
        "codex_turn_start_failed",
        "Codex emitted too many turn completions before the turn/start response",
      );
    }
    // id が分かったので保留分を照合する。 自分のターンのものだけ採用し、
    // 他ターンのものは捨てる。
    const deferredCompletion = deferredCompletions.find(
      (deferred) => deferred.completion.turnId === activeTurnId,
    );
    deferredCompletions.length = 0;
    if (deferredCompletion) {
      const framePost = deferredCompletion.frame
        ? session.sink.post(deferredCompletion.frame.kind, deferredCompletion.frame.payload)
        : Promise.resolve(null);
      settleCompletion(deferredCompletion.completion, framePost);
    }

    await withTimeout(
      completionPromise,
      positiveInt(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
      () => new CodexDelegationError(
        "codex_turn_timeout",
        "Codex delegation turn timed out",
      ),
    );
  } finally {
    settled = true;
    unsubscribe();
  }
}

export async function closeCodexAppServerSession(session: CodexAppServerSession): Promise<void> {
  let flushError: Error | null = null;
  try {
    await session.sink.flush();
  } catch (error) {
    flushError = asError(error);
  }
  await session.client.close();
  if (flushError) throw flushError;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(errorFactory()), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
