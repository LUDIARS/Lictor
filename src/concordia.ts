import type {
  ConcordiaChatPayload,
  ConcordiaConflictsResponse,
  ConcordiaEventPayload,
  ConcordiaPersona,
  ConcordiaSessionRegister,
  ConcordiaSessionResponse,
  DeleteSessionResponse,
  DiscordChannels,
  PendingTasksResponse,
  SessionPatch,
} from "./concordia-types.js";

const DEFAULT_HOST = "127.0.0.1";
// Concordia backend の loopback port。 Concordia 本体 (concordia.config.json /
// shared/config.ts) は 11111 を bind するため既定もそれに揃える。 通常は Concordia が
// spawn 時に CONCORDIA_HOST/PORT を注入するので、 この既定は env 無し起動時のみ効く。
// (canonical infra/PORT-MAP.md は 17330 を記載しているが、 実体は 11111。 PORT-MAP 側の
// 全面見直し時に再整理予定。)
const DEFAULT_PORT = 11111;

export interface ConcordiaConfig {
  host: string;
  port: number;
  baseUrl: string;
  enabled: boolean;
}

export function loadConcordiaConfig(env: NodeJS.ProcessEnv = process.env): ConcordiaConfig {
  const host = env.CONCORDIA_HOST?.trim() || DEFAULT_HOST;
  const port = Number(env.CONCORDIA_PORT) || DEFAULT_PORT;
  const enabled = env.LICTOR_DISABLE_CONCORDIA !== "1";
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    enabled,
  };
}

export interface RegisteredSession {
  id: string;
  persona: ConcordiaPersona | null;
  roleLabel: string | null;
}

export class ConcordiaClient {
  constructor(public readonly cfg: ConcordiaConfig) {}

  async register(payload: ConcordiaSessionRegister): Promise<RegisteredSession> {
    const res = await this.fetchJson<ConcordiaSessionResponse>("POST", "/v1/sessions", payload);
    const persona = res.persona ?? null;
    const roleLabel =
      (res.session?.metadata?.role_label as string | undefined) ??
      (persona?.role_label as string | undefined) ??
      null;
    return { id: payload.id, persona, roleLabel };
  }

  async unregister(id: string): Promise<DeleteSessionResponse | null> {
    // Best-effort — server may already have GC'd if WS connection dropped.
    try {
      return await this.fetchJson<DeleteSessionResponse>(
        "DELETE",
        `/v1/sessions/${encodeURIComponent(id)}`,
      );
    } catch {
      return null;
    }
  }

  async patchSession(id: string, patch: SessionPatch): Promise<void> {
    await this.fetchJson("PATCH", `/v1/sessions/${encodeURIComponent(id)}`, patch);
  }

  async pendingTasks(id: string): Promise<PendingTasksResponse> {
    return this.fetchJson<PendingTasksResponse>(
      "GET",
      `/v1/sessions/${encodeURIComponent(id)}/pending-tasks`,
    );
  }

  async stat(id: string, payload: unknown): Promise<void> {
    await this.fetchJson("POST", `/v1/stat/${encodeURIComponent(id)}`, { payload });
  }

  async chat(payload: ConcordiaChatPayload): Promise<unknown> {
    return this.fetchJson("POST", "/v1/chat", payload);
  }

  /**
   * 自分の session に紐づく Discord channel ID 群を取得する
   * (spec/discord-lictor-relay.md §4.1)。channel 作成は非同期なので
   * session_channel_id は初回 null になりうる — 呼び出し側がリトライする。
   */
  async discordChannels(id: string): Promise<DiscordChannels> {
    return this.fetchJson<DiscordChannels>(
      "GET",
      `/v1/sessions/${encodeURIComponent(id)}/discord-channels`,
    );
  }

  /**
   * daily-report の感想文 (monologue) を session の report に追記する。
   * session_id は呼び出し側 (sidecar) が authoritative に渡す。
   */
  async reportAppend(id: string, payload: { role: string; monologue: string }): Promise<unknown> {
    return this.fetchJson(
      "POST",
      `/v1/reports/${encodeURIComponent(id)}/append`,
      payload,
    );
  }

  async event(id: string, payload: ConcordiaEventPayload): Promise<unknown> {
    return this.fetchJson(
      "POST",
      `/v1/sessions/${encodeURIComponent(id)}/event`,
      payload,
    );
  }

  /**
   * Notify Concordia that a PreToolUse hook is blocked waiting for a
   * decision. Concordia broadcasts a session-targeted
   * `session.permission_request` event so the Web UI modal shows up.
   * Response arrives separately via `/v1/internal/permission-response`
   * (proxied from Concordia's `/v1/sessions/:id/permission-response`).
   */
  async permissionRequest(
    id: string,
    payload: { request_id: string; tool_name: string; tool_input: unknown },
  ): Promise<unknown> {
    return this.fetchJson(
      "POST",
      `/v1/sessions/${encodeURIComponent(id)}/permission-request`,
      payload,
    );
  }

  async conflicts(opts: {
    repo: string;
    branch?: string;
    excludeSession?: string;
  }): Promise<ConcordiaConflictsResponse> {
    const params = new URLSearchParams();
    params.set("repo", opts.repo);
    if (opts.branch) params.set("branch", opts.branch);
    if (opts.excludeSession) params.set("exclude_session", opts.excludeSession);
    return this.fetchJson<ConcordiaConflictsResponse>(
      "GET",
      `/v1/monitor/conflicts?${params.toString()}`,
    );
  }

  /**
   * Open a WebSocket to /ws?session=<id> for liveness. Concordia treats an
   * active WS as a heartbeat substitute (no need to POST /v1/sessions/:id/heartbeat).
   *
   * If `onMessage` is supplied, broadcast JSON events from Concordia's
   * eventBus are decoded and dispatched. Otherwise messages are ignored
   * (pre-v0.3 behavior).
   *
   * Returns an object with close() and an isOpen indicator. Reconnects on
   * unexpected close with exponential backoff capped at 30s.
   */
  openLiveness(id: string, onMessage?: WsMessageHandler): LivenessHandle {
    return new LivenessHandle(this.cfg, id, onMessage);
  }

  private async fetchJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Concordia ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Concordia ${method} ${path}: non-JSON response`);
    }
  }
}

export type WsMessageHandler = (msg: unknown) => void;

export class LivenessHandle {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1000;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: ConcordiaConfig,
    private readonly sessionId: string,
    private readonly onMessage?: WsMessageHandler,
  ) {
    this.connect();
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closed) return;
    const wsUrl = `ws://${this.cfg.host}:${this.cfg.port}/ws?session=${encodeURIComponent(this.sessionId)}`;
    try {
      // Node 22+ ships a global WebSocket.
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.retryMs = 1000;
      });
      ws.addEventListener("close", () => {
        this.ws = null;
        if (!this.closed) this.scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        // Will also fire close — let close handle reconnect.
      });
      if (this.onMessage) {
        ws.addEventListener("message", (ev) => {
          if (!this.onMessage) return;
          try {
            const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
            this.onMessage(JSON.parse(raw));
          } catch {
            // Malformed messages are dropped silently — Concordia sends well-
            // formed JSON in practice.
          }
        });
      }
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    // Don't keep the event loop alive for retries alone.
    this.timer.unref?.();
  }
}

export function openLiveness(
  cfg: ConcordiaConfig,
  id: string,
  onMessage?: WsMessageHandler,
): LivenessHandle {
  return new LivenessHandle(cfg, id, onMessage);
}
