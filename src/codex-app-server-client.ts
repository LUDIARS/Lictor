import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

const RpcIdSchema = z.union([z.number().int(), z.string()]);
const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
}).passthrough();
const RpcMessageSchema = z.object({
  id: RpcIdSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: RpcErrorSchema.optional(),
}).passthrough();

export interface CodexRpcNotification {
  method: string;
  params: unknown;
}

export interface CodexRpcServerRequest extends CodexRpcNotification {
  id: string | number;
}

export type CodexServerRequestHandler = (
  request: CodexRpcServerRequest,
) => Promise<unknown> | unknown;

export type CodexAppServerErrorCode =
  | "codex_app_server_start_failed"
  | "codex_app_server_protocol_error"
  | "codex_app_server_request_failed"
  | "codex_app_server_timeout"
  | "codex_app_server_closed";

export class CodexAppServerError extends Error {
  constructor(
    public readonly code: CodexAppServerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexAppServerError";
  }
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingNotification {
  method: string;
  resolve: (notification: CodexRpcNotification) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions {
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
  serverRequestHandler?: CodexServerRequestHandler;
}

export interface SpawnCodexAppServerOptions extends CodexAppServerClientOptions {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnProcess?: () => ChildProcessWithoutNullStreams;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

/** JSONL JSON-RPC client for one local `codex app-server` process. */
export class CodexAppServerClient {
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private closed = false;
  private exited = false;
  private fatalError: Error | null = null;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly notificationWaiters = new Set<PendingNotification>();
  private readonly notificationListeners = new Set<(notification: CodexRpcNotification) => void>();
  private readonly requestTimeoutMs: number;
  private readonly onDiagnostic: (message: string) => void;
  private readonly serverRequestHandler: CodexServerRequestHandler;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: CodexAppServerClientOptions = {},
  ) {
    this.requestTimeoutMs = positiveInt(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.serverRequestHandler = options.serverRequestHandler ?? defaultServerRequestHandler;

    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exited = true;
        const error = this.fatalError ?? new CodexAppServerError(
          "codex_app_server_closed",
          `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
        this.rejectAll(error);
        resolve({ code, signal });
      });
    });

    child.once("error", (error) => {
      this.fail(new CodexAppServerError(
        "codex_app_server_start_failed",
        "codex app-server process failed",
        { cause: error },
      ));
    });
    child.stdout.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const safe = redactDiagnostic(String(chunk)).trim();
      if (safe) this.onDiagnostic(safe.slice(0, 2_000));
    });
  }

  static spawn(options: SpawnCodexAppServerOptions): CodexAppServerClient {
    const child = options.spawnProcess?.() ?? spawnCodexAppServer(options);
    return new CodexAppServerClient(child, options);
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed || this.exited || this.fatalError) {
      return Promise.reject(this.fatalError ?? new CodexAppServerError(
        "codex_app_server_closed",
        "codex app-server is not available",
      ));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(
          "codex_app_server_timeout",
          `codex app-server request timed out: ${method}`,
        ));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed || this.exited || this.fatalError) {
      throw this.fatalError ?? new CodexAppServerError(
        "codex_app_server_closed",
        "codex app-server is not available",
      );
    }
    this.write({ method, params });
  }

  onNotification(listener: (notification: CodexRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  waitForNotification(method: string, timeoutMs = this.requestTimeoutMs): Promise<CodexRpcNotification> {
    if (this.closed || this.exited || this.fatalError) {
      return Promise.reject(this.fatalError ?? new CodexAppServerError(
        "codex_app_server_closed",
        "codex app-server is not available",
      ));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notificationWaiters.delete(waiter);
        reject(new CodexAppServerError(
          "codex_app_server_timeout",
          `codex app-server notification timed out: ${method}`,
        ));
      }, positiveInt(timeoutMs, this.requestTimeoutMs));
      timer.unref?.();
      const waiter: PendingNotification = { method, resolve, reject, timer };
      this.notificationWaiters.add(waiter);
    });
  }

  async close(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new CodexAppServerError(
      "codex_app_server_closed",
      "codex app-server client closed",
    ));
    if (!this.exited) this.child.stdin.end();
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      delay(positiveInt(timeoutMs, DEFAULT_CLOSE_TIMEOUT_MS)).then(() => false),
    ]);
    if (!exited && !this.exited) {
      this.child.kill("SIGTERM");
      await this.exitPromise;
    }
  }

  terminate(): void {
    if (this.closed && this.exited) return;
    this.closed = true;
    this.rejectAll(new CodexAppServerError(
      "codex_app_server_closed",
      "codex app-server terminated",
    ));
    if (!this.exited) this.child.kill("SIGTERM");
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.fatalError) return;
    this.stdoutBuffer += String(chunk);
    if (this.stdoutBuffer.length > MAX_BUFFER_CHARS) {
      this.fail(new CodexAppServerError(
        "codex_app_server_protocol_error",
        "codex app-server JSONL buffer exceeded 4 MiB without a complete line",
      ));
      return;
    }
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) continue;
      this.handleLine(line);
      if (this.fatalError) return;
    }
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      this.fail(new CodexAppServerError(
        "codex_app_server_protocol_error",
        "codex app-server emitted malformed JSONL",
        { cause: asError(error) },
      ));
      return;
    }
    const parsed = RpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.fail(new CodexAppServerError(
        "codex_app_server_protocol_error",
        "codex app-server emitted an invalid JSON-RPC message",
      ));
      return;
    }
    const message = parsed.data;

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params ?? {},
      });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.fail(new CodexAppServerError(
          "codex_app_server_protocol_error",
          `codex app-server returned unknown or duplicate response id=${message.id}`,
        ));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CodexAppServerError(
          "codex_app_server_request_failed",
          `${pending.method} failed (${message.error.code}): ${message.error.message}`,
        ));
      } else if (Object.prototype.hasOwnProperty.call(message, "result")) {
        pending.resolve(message.result);
      } else {
        pending.reject(new CodexAppServerError(
          "codex_app_server_protocol_error",
          `${pending.method} response omitted result and error`,
        ));
      }
      return;
    }
    if (message.method) {
      const notification = { method: message.method, params: message.params ?? {} };
      for (const waiter of [...this.notificationWaiters]) {
        if (waiter.method !== notification.method) continue;
        clearTimeout(waiter.timer);
        this.notificationWaiters.delete(waiter);
        waiter.resolve(notification);
      }
      for (const listener of [...this.notificationListeners]) listener(notification);
      return;
    }
    this.fail(new CodexAppServerError(
      "codex_app_server_protocol_error",
      "codex app-server emitted an unclassifiable JSON-RPC message",
    ));
  }

  private async handleServerRequest(request: CodexRpcServerRequest): Promise<void> {
    try {
      const result = await this.serverRequestHandler(request);
      this.write({ id: request.id, result });
    } catch (error) {
      const safe = asError(error).message.slice(0, 500);
      try {
        this.write({
          id: request.id,
          error: { code: -32603, message: safe || "server request rejected" },
        });
      } catch (writeError) {
        this.onDiagnostic(`failed to answer Codex server request: ${redactDiagnostic(asError(writeError).message)}`);
      }
    }
  }

  private write(message: unknown): void {
    if (!this.child.stdin.writable) {
      throw new CodexAppServerError(
        "codex_app_server_closed",
        "codex app-server stdin is not writable",
      );
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.rejectAll(error);
    if (!this.exited) this.child.kill("SIGTERM");
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }
}

function spawnCodexAppServer(options: SpawnCodexAppServerOptions): ChildProcessWithoutNullStreams {
  const args = ["app-server", "--listen", "stdio://"];
  if (process.platform !== "win32") {
    return spawn(options.binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      windowsHide: true,
    });
  }
  if (/[\0\r\n&|<>^]/u.test(options.binary)) {
    throw new CodexAppServerError(
      "codex_app_server_start_failed",
      "unsafe character in Codex binary path",
    );
  }
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", options.binary, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
    windowsHide: true,
  });
}

function defaultServerRequestHandler(request: CodexRpcServerRequest): unknown {
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline" };
  }
  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (request.method === "tool/requestUserInput") {
    return { answers: {} };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null };
  }
  throw new CodexAppServerError(
    "codex_app_server_request_failed",
    `unsupported app-server request: ${request.method}`,
  );
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/\b(?:sk|sess|rk)-[A-Za-z0-9_-]{8,}\b/gu, "****")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/giu, "$1****")
    .replace(/("?(?:accessToken|refreshToken|apiKey|token)"?\s*[:=]\s*")[^"]+/giu, "$1****");
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
