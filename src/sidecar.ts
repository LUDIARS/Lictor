import http from "node:http";
import type { AddressInfo } from "node:net";
import { resetTitle, setTitle } from "./osc.js";
import type { Meta } from "./meta.js";
import type { ConcordiaClient } from "./concordia.js";

export interface TitleState {
  manualOverride: string | null;
}

export interface SidecarContext {
  meta: Meta;
  titleState: TitleState;
  concordia: ConcordiaClient | null;
  sessionId: string | null;
  roleLabel: string | null;
}

export interface Sidecar {
  port: number;
  close: () => void;
}

export async function startSidecar(ctx: SidecarContext): Promise<Sidecar> {
  const server = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end('{"error":"loopback only"}');
      return;
    }

    void handle(req, res, ctx).catch((err) => {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error("failed to bind sidecar"));
        return;
      }
      resolve({
        port: addr.port,
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

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: SidecarContext,
): Promise<void> {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/v1/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && url === "/v1/meta") {
    writeJson(res, 200, ctx.meta);
    return;
  }

  if (method === "GET" && url === "/v1/concordia/session") {
    writeJson(res, 200, {
      session_id: ctx.sessionId,
      persona: ctx.meta.persona,
      role_label: ctx.roleLabel,
      concordia_enabled: ctx.concordia !== null,
    });
    return;
  }

  if (method === "POST" && url === "/v1/title") {
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const text = (body.value as { text?: unknown }).text;
    if (typeof text !== "string") {
      return writeJson(res, 400, { error: "body.text (string) is required" });
    }
    ctx.titleState.manualOverride = text;
    setTitle(text);
    writeJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url === "/v1/title/auto") {
    // Caller asks lictor to drop the manual override and resume auto title.
    ctx.titleState.manualOverride = null;
    resetTitle();
    writeJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url === "/v1/chat") {
    if (!ctx.concordia || !ctx.sessionId) {
      return writeJson(res, 503, { error: "Concordia not registered for this session" });
    }
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as {
      channel?: unknown;
      text?: unknown;
      author_label?: unknown;
      scope?: unknown;
    };
    if (typeof payload.channel !== "string" || typeof payload.text !== "string") {
      return writeJson(res, 400, { error: "channel and text (string) required" });
    }
    const authorLabel =
      typeof payload.author_label === "string" && payload.author_label.length > 0
        ? payload.author_label
        : defaultAuthorLabel(ctx);
    const reply = await ctx.concordia.chat({
      channel: payload.channel,
      text: payload.text,
      author_label: authorLabel,
      session_id: ctx.sessionId,
      scope: typeof payload.scope === "string" ? payload.scope : undefined,
    });
    writeJson(res, 200, reply);
    return;
  }

  if (method === "POST" && url === "/v1/event") {
    if (!ctx.concordia || !ctx.sessionId) {
      return writeJson(res, 503, { error: "Concordia not registered for this session" });
    }
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as { kind?: unknown; payload?: unknown; ts?: unknown };
    if (typeof payload.kind !== "string") {
      return writeJson(res, 400, { error: "kind (string) required" });
    }
    const reply = await ctx.concordia.event(ctx.sessionId, {
      kind: payload.kind,
      payload: payload.payload,
      ts: typeof payload.ts === "number" ? payload.ts : undefined,
    });
    writeJson(res, 200, reply);
    return;
  }

  if (method === "GET" && url.startsWith("/v1/conflicts")) {
    if (!ctx.concordia) {
      return writeJson(res, 503, { error: "Concordia not registered for this session" });
    }
    const u = new URL(url, "http://localhost");
    const repo = u.searchParams.get("repo") ?? ctx.meta.cwd;
    const branch = u.searchParams.get("branch") ?? undefined;
    const reply = await ctx.concordia.conflicts({
      repo,
      branch,
      excludeSession: ctx.sessionId ?? undefined,
    });
    writeJson(res, 200, reply);
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

/**
 * Default `author_label` follows the LUDIARS convention of
 * `<role> / <name>` (e.g. `深掘り型 / 淵渡 一`). Falls back to role-only
 * or persona-name-only when half the data is missing, then to a literal
 * `lictor` so the chat call never fails purely for label reasons.
 */
function defaultAuthorLabel(ctx: SidecarContext): string {
  const persona = ctx.meta.persona;
  const role = (persona?.name as string | undefined) ?? ctx.roleLabel ?? null;
  const displayName = (persona?.display_name as string | undefined) ?? null;
  if (role && displayName) return `${role} / ${displayName}`;
  if (role) return role;
  if (displayName) return displayName;
  return "lictor";
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
