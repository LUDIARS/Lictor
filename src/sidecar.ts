import http from "node:http";
import type { AddressInfo } from "node:net";
import { resetTitle, setTitle } from "./osc.js";
import type { Meta } from "./meta.js";
import type { ConcordiaClient } from "./concordia.js";
import type { SkillInjector } from "./skill-injector.js";
import type { NotifyState } from "./event-reactor.js";
import type { ConflictState } from "./conflict-watcher.js";
import type { TaskState } from "./task-relay.js";
import { relayTask } from "./task-relay.js";

export interface TitleState {
  manualOverride: string | null;
}

export interface SidecarContext {
  meta: Meta;
  titleState: TitleState;
  concordia: ConcordiaClient | null;
  sessionId: string | null;
  roleLabel: string | null;
  injector: SkillInjector | null;
  /**
   * Writes raw bytes to the wrapped claude's pty stdin. Set by wrap.ts after
   * the pty is spawned; null when the sidecar is started without a pty (e.g.
   * the smoke-sidecar.mjs harness or local-server.mjs). Endpoints that
   * require keystroke injection (`/v1/rename`, future `/v1/keys`) must 503
   * when this is null.
   */
  ptyWriter: ((data: string) => void) | null;
  /**
   * v0.4 live state mutated by background cron + WS event reactor. Always
   * provided (default zero values) so handlers don't have to null-check.
   */
  notifyState: NotifyState;
  conflictState: ConflictState;
  taskState: TaskState;
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

  if (method === "POST" && url === "/v1/rename") {
    if (!ctx.ptyWriter) {
      return writeJson(res, 503, { error: "pty not available — sidecar not wrapping a claude session" });
    }
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const text = (body.value as { text?: unknown }).text;
    if (typeof text !== "string") {
      return writeJson(res, 400, { error: "body.text (string) is required" });
    }
    const sanitized = sanitizeRenameArg(text);
    if (!sanitized) {
      return writeJson(res, 400, { error: "text is empty after sanitization" });
    }
    // \r is what TUIs (incl. claude in raw mode) treat as Enter. We send the
    // full slash command as one write so claude's input parser sees an atomic
    // submission; partial writes would race with user keystrokes.
    ctx.ptyWriter(`/rename ${sanitized}\r`);
    writeJson(res, 200, { ok: true, sent: sanitized });
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

  if (method === "GET" && url === "/v1/skill") {
    if (!ctx.injector) return writeJson(res, 503, { error: "skill injector not initialized" });
    writeJson(res, 200, {
      session_dir: ctx.injector.sessionDir,
      skills_dir: ctx.injector.skillsDir,
      skills: ctx.injector.list(),
    });
    return;
  }

  if (method === "POST" && url === "/v1/skill") {
    if (!ctx.injector) return writeJson(res, 503, { error: "skill injector not initialized" });
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as { name?: unknown; content?: unknown };
    if (typeof payload.name !== "string" || typeof payload.content !== "string") {
      return writeJson(res, 400, { error: "name and content (string) required" });
    }
    try {
      ctx.injector.writeSkill(payload.name, payload.content);
      writeJson(res, 200, { ok: true });
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (method === "DELETE" && url.startsWith("/v1/skill/")) {
    if (!ctx.injector) return writeJson(res, 503, { error: "skill injector not initialized" });
    const name = decodeURIComponent(url.slice("/v1/skill/".length));
    const ok = ctx.injector.deleteSkill(name);
    writeJson(res, ok ? 200 : 404, { ok });
    return;
  }

  if (method === "POST" && url === "/v1/lictor/task") {
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as { branch?: unknown; desc?: unknown };
    const branch =
      payload.branch === undefined || payload.branch === null
        ? undefined
        : typeof payload.branch === "string"
          ? payload.branch
          : undefined;
    const desc =
      payload.desc === undefined || payload.desc === null
        ? undefined
        : typeof payload.desc === "string"
          ? payload.desc
          : undefined;
    if (branch === undefined && desc === undefined) {
      return writeJson(res, 400, { error: "at least one of branch or desc must be a string" });
    }
    const next = await relayTask({
      client: ctx.concordia,
      sessionId: ctx.sessionId,
      injector: ctx.injector,
      state: ctx.taskState,
      branch,
      desc,
      source: "explicit",
    });
    ctx.taskState = next;
    writeJson(res, 200, { ok: true, task: next });
    return;
  }

  if (method === "GET" && url === "/v1/lictor/task") {
    writeJson(res, 200, ctx.taskState);
    return;
  }

  if (method === "GET" && url === "/v1/lictor/state") {
    writeJson(res, 200, {
      notify: ctx.notifyState,
      conflict: ctx.conflictState,
      task: ctx.taskState,
    });
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

/**
 * Strip controls / quotes / leading slashes that would break claude's
 * /rename parser or let a malicious caller chain commands.
 * - C0 + DEL: would terminate the line early or inject other key events.
 * - Leading "/": prevents the caller from sneaking in another slash command.
 * - 200-char cap matches sanitizeTitle's contract — Web UI truncates anyway.
 */
export function sanitizeRenameArg(text: string): string {
  return text
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/^\/+/, "")
    .trim()
    .slice(0, 200);
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
