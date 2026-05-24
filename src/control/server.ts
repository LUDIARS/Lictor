import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { ensureToken, extractToken, tokenMatches } from "./token.js";
import { spawnSession, type SpawnMode, type SpawnRequest } from "./spawner.js";

export const DEFAULT_CONTROL_PORT = 17340;

export interface ControlServer {
  port: number;
  close: () => void;
  token: string;
}

export interface ControlServerOptions {
  port?: number;
  /** Override token storage location (for tests). */
  homeRoot?: string;
}

export interface SpawnRecord {
  id: string;
  ts: string;
  request: SpawnRequest;
  command: string[];
  pid: number | null;
}

const records: SpawnRecord[] = [];

export function recentSpawns(): SpawnRecord[] {
  return records.slice(-50);
}

export async function startControlServer(opts: ControlServerOptions = {}): Promise<ControlServer> {
  const token = ensureToken(opts.homeRoot);
  const port = opts.port ?? DEFAULT_CONTROL_PORT;

  const server = http.createServer((req, res) => {
    // Loopback guard — same posture as the per-session sidecar.
    const remote = req.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end('{"error":"loopback only"}');
      return;
    }
    void handle(req, res, token).catch((err) => {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error("failed to bind control server"));
        return;
      }
      resolve({
        port: addr.port,
        token,
        close: () => {
          try {
            server.close();
          } catch {
            // best-effort
          }
        },
      });
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, expectedToken: string): Promise<void> {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // /v1/health is reachable WITHOUT a token so monitors / liveness probes
  // don't need to know the secret. Everything else demands the bearer.
  if (method === "GET" && url === "/v1/health") {
    writeJson(res, 200, { ok: true, role: "control-lictor" });
    return;
  }

  const provided = extractToken(req.headers);
  if (!provided || !tokenMatches(expectedToken, provided)) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="lictor-control"',
    });
    res.end('{"error":"missing or invalid token"}');
    return;
  }

  if (method === "POST" && url === "/v1/spawn") {
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as Partial<SpawnRequest> & Record<string, unknown>;
    const provider = payload.provider ?? "claude";
    if (provider !== "claude" && provider !== "codex") {
      return writeJson(res, 400, { error: `unknown provider: ${String(provider)}` });
    }
    const mode: SpawnMode = payload.mode === "window" ? "window" : "tab";
    const request: SpawnRequest = {
      provider,
      mode,
      args: Array.isArray(payload.args) ? (payload.args as string[]).filter((x) => typeof x === "string") : undefined,
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      title: typeof payload.title === "string" ? payload.title : undefined,
      env: isStringMap(payload.env) ? payload.env : undefined,
    };
    const result = spawnSession(request);
    if ("error" in result) {
      return writeJson(res, 400, { error: result.error });
    }
    const id = randomUUID();
    const record: SpawnRecord = {
      id,
      ts: new Date().toISOString(),
      request,
      command: result.command,
      pid: result.pid,
    };
    records.push(record);
    writeJson(res, 200, { ok: true, id, pid: result.pid, command: result.command });
    return;
  }

  if (method === "GET" && url === "/v1/sessions") {
    writeJson(res, 200, { sessions: recentSpawns() });
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

function isStringMap(x: unknown): x is Record<string, string> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  for (const v of Object.values(x as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface JsonResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

function readJson(req: http.IncomingMessage): Promise<JsonResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 64 * 1024;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        req.destroy();
        resolve({ ok: false, error: "body too large" });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, error: "invalid JSON" });
      }
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}
