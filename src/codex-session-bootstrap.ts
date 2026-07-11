import { z } from "zod";
import {
  CodexAppServerError,
  type CodexAppServerClient,
} from "./codex-app-server-client.js";
import type { TranscriptFrameSink } from "./transcript-sink.js";

const AccountSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey") }).passthrough(),
  z.object({
    type: z.literal("chatgpt"),
    email: z.string().nullable(),
    planType: z.string(),
  }).passthrough(),
  z.object({ type: z.literal("amazonBedrock") }).passthrough(),
]);
const AccountResponseSchema = z.object({
  account: AccountSchema.nullable().optional(),
  requiresOpenaiAuth: z.boolean(),
}).passthrough();
const ThreadSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
}).passthrough();
const ThreadStartResponseSchema = z.object({
  thread: ThreadSchema,
}).passthrough();
const ThreadStartedParamsSchema = z.object({
  thread: z.object({ id: z.string().min(1) }).passthrough(),
}).passthrough();

export type CodexBootstrapErrorCode =
  | "codex_auth_required"
  | "codex_thread_start_failed"
  | "codex_binding_persist_failed";

export class CodexBootstrapError extends Error {
  constructor(
    public readonly code: CodexBootstrapErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexBootstrapError";
  }
}

export interface CodexSessionIdentity {
  threadId: string;
  sessionId: string;
  authType: "apiKey" | "chatgpt" | "amazonBedrock";
  planType: string | null;
}

export interface BootstrapCodexSessionOptions {
  cwd: string;
  clientName?: string;
  clientTitle?: string;
  clientVersion: string;
  serviceName?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  notificationTimeoutMs?: number;
}

/** Initializes App Server, validates auth, binds a thread, then persists seq=0. */
export async function bootstrapCodexSession(
  client: CodexAppServerClient,
  sink: TranscriptFrameSink,
  options: BootstrapCodexSessionOptions,
): Promise<CodexSessionIdentity> {
  await client.request("initialize", {
    clientInfo: {
      name: options.clientName ?? "lictor",
      title: options.clientTitle ?? "Lictor",
      version: options.clientVersion,
    },
  });
  client.notify("initialized", {});

  const accountRaw = await client.request("account/read", { refreshToken: false });
  const accountResult = AccountResponseSchema.safeParse(accountRaw);
  if (!accountResult.success) {
    throw new CodexAppServerError(
      "codex_app_server_protocol_error",
      "account/read returned an invalid response",
    );
  }
  const account = accountResult.data.account ?? null;
  if (!account && accountResult.data.requiresOpenaiAuth) {
    throw new CodexBootstrapError(
      "codex_auth_required",
      "Codex authentication is required; run `codex login` before starting Lictor",
    );
  }
  if (!account) {
    throw new CodexBootstrapError(
      "codex_auth_required",
      "Codex account state is unavailable",
    );
  }

  const startedNotification = client.waitForNotification(
    "thread/started",
    options.notificationTimeoutMs,
  );
  let threadRaw: unknown;
  try {
    threadRaw = await client.request("thread/start", {
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "workspace-write",
      serviceName: options.serviceName ?? "lictor",
    });
  } catch (error) {
    void startedNotification.catch(() => undefined);
    throw new CodexBootstrapError(
      "codex_thread_start_failed",
      "Codex thread/start failed",
      { cause: asError(error) },
    );
  }
  const threadResult = ThreadStartResponseSchema.safeParse(threadRaw);
  if (!threadResult.success) {
    void startedNotification.catch(() => undefined);
    throw new CodexBootstrapError(
      "codex_thread_start_failed",
      "Codex thread/start response omitted thread.id or thread.sessionId",
    );
  }

  const notification = await startedNotification;
  const notificationResult = ThreadStartedParamsSchema.safeParse(notification.params);
  if (!notificationResult.success) {
    throw new CodexBootstrapError(
      "codex_thread_start_failed",
      "Codex thread/started notification was invalid",
    );
  }
  const thread = threadResult.data.thread;
  if (notificationResult.data.thread.id !== thread.id) {
    throw new CodexBootstrapError(
      "codex_thread_start_failed",
      "Codex thread/start response and thread/started notification disagreed",
    );
  }

  try {
    await sink.post("raw", {
      type: "codex_session_bound",
      codex_thread_id: thread.id,
      codex_session_id: thread.sessionId,
      transport: "app-server",
    }, { requirePersisted: true });
  } catch (error) {
    throw new CodexBootstrapError(
      "codex_binding_persist_failed",
      "failed to persist Codex session binding",
      { cause: asError(error) },
    );
  }

  return {
    threadId: thread.id,
    sessionId: thread.sessionId,
    authType: account.type,
    planType: account.type === "chatgpt" ? account.planType : null,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
