import { z } from "zod";
import {
  CodexAppServerClient,
  type SpawnCodexAppServerOptions,
} from "./codex-app-server-client.js";
import {
  CodexEventFrameMapper,
  notificationThreadId,
  parseTurnCompletion,
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
  let activeTurnId: string | null = null;
  let settled = false;
  let resolveCompletion: (() => void) | null = null;
  let rejectCompletion: ((error: Error) => void) | null = null;
  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const unsubscribe = session.client.onNotification((notification) => {
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

    const frame = mapper.map(notification);
    const framePost = frame
      ? session.sink.post(frame.kind, frame.payload)
      : Promise.resolve(null);
    const completion = parseTurnCompletion(notification, session.identity.threadId);
    if (!completion) {
      void framePost.catch((error: unknown) => {
        if (settled) return;
        settled = true;
        rejectCompletion?.(asError(error));
      });
      return;
    }
    if (activeTurnId && completion.turnId !== activeTurnId) {
      settled = true;
      rejectCompletion?.(new CodexDelegationError(
        "codex_thread_mismatch",
        "turn/completed did not match the active delegation turn",
      ));
      return;
    }
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
  });

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
