import type {
  ConcordiaChatPayload,
  ConcordiaConflictsResponse,
  ConcordiaEventPayload,
  ConcordiaPersona,
  ConcordiaSessionRegister,
  ConcordiaSessionResponse,
} from "./concordia-types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17330;

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

  async unregister(id: string): Promise<void> {
    // Best-effort — server may already have GC'd if WS connection dropped.
    try {
      await this.fetchJson<unknown>("DELETE", `/v1/sessions/${encodeURIComponent(id)}`);
    } catch {
      // ignore
    }
  }

  async stat(id: string, payload: unknown): Promise<void> {
    await this.fetchJson("POST", `/v1/stat/${encodeURIComponent(id)}`, { payload });
  }

  async chat(payload: ConcordiaChatPayload): Promise<unknown> {
    return this.fetchJson("POST", "/v1/chat", payload);
  }

  async event(id: string, payload: ConcordiaEventPayload): Promise<unknown> {
    return this.fetchJson(
      "POST",
      `/v1/sessions/${encodeURIComponent(id)}/event`,
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
   * Returns an object with close() and an isOpen indicator. Reconnects on
   * unexpected close with exponential backoff capped at 30s.
   */
  openLiveness(id: string): LivenessHandle {
    return new LivenessHandle(this.cfg, id);
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

export class LivenessHandle {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1000;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: ConcordiaConfig,
    private readonly sessionId: string,
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
