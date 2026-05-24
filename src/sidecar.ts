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
import { fsRead, fsList, fsGrep } from "./fs-rpc.js";

export interface TitleState {
  manualOverride: string | null;
}

export interface PermissionDecision {
  decision: "allow" | "deny" | "ask";
  reason?: string;
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
  /**
   * v0.6 permission proxy — map of pending PreToolUse requests waiting for
   * a Web UI / Concordia response. Key is request_id (uuid). The promise
   * resolver lets `/v1/internal/permission-check` block until either a
   * matching `/v1/internal/permission-response` arrives or the timeout
   * fires (default-allow).
   */
  pendingPermissions: Map<string, (decision: PermissionDecision) => void>;
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

  if (method === "POST" && url === "/v1/keys") {
    if (!ctx.ptyWriter) {
      return writeJson(res, 503, { error: "pty not available — sidecar not wrapping a claude session" });
    }
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const data = (body.value as { data?: unknown }).data;
    if (typeof data !== "string") {
      return writeJson(res, 400, { error: "body.data (string) is required" });
    }
    const safe = sanitizeKeySeq(data);
    if (!safe) {
      return writeJson(res, 400, { error: "data is empty after sanitization" });
    }
    ctx.ptyWriter(safe);
    writeJson(res, 200, { ok: true, sent_bytes: Buffer.byteLength(safe, "utf8") });
    return;
  }

  if (method === "POST" && url === "/v1/answer") {
    if (!ctx.ptyWriter) {
      return writeJson(res, 503, { error: "pty not available — sidecar not wrapping a claude session" });
    }
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as { choice?: unknown; escape_first?: unknown };
    if (typeof payload.choice !== "number") {
      return writeJson(res, 400, { error: "body.choice (number ≥ 1) is required" });
    }
    try {
      const seq = buildAnswerSequence(payload.choice, payload.escape_first === true);
      ctx.ptyWriter(seq);
      writeJson(res, 200, { ok: true, choice: payload.choice });
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (method === "POST" && url === "/v1/slash") {
    if (!ctx.ptyWriter) {
      return writeJson(res, 503, {
        error: "pty not available — sidecar not wrapping a claude session",
      });
    }
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as { cmd?: unknown; args?: unknown };
    if (typeof payload.cmd !== "string") {
      return writeJson(res, 400, { error: "body.cmd (string) is required" });
    }
    const cmd = sanitizeSlashCmd(payload.cmd);
    if (!cmd) {
      return writeJson(res, 400, {
        error: "cmd must match ^[a-z][a-z0-9-]{0,40}$ (claude slash command grammar)",
      });
    }
    let line: string;
    if (payload.args === undefined || payload.args === null || payload.args === "") {
      line = `/${cmd}\r`;
    } else if (typeof payload.args !== "string") {
      return writeJson(res, 400, { error: "body.args must be a string when provided" });
    } else {
      const args = sanitizeRenameArg(payload.args);
      line = args ? `/${cmd} ${args}\r` : `/${cmd}\r`;
    }
    ctx.ptyWriter(line);
    writeJson(res, 200, { ok: true, sent: line.trimEnd() });
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

  // Filesystem RPC — cwd-confined. Concordia proxies through these.
  if (method === "GET" && url.startsWith("/v1/fs/read")) {
    const u = new URL(url, "http://localhost");
    const p = u.searchParams.get("path") ?? "";
    const out = fsRead(ctx.meta.cwd, p);
    if ("error" in out) return writeJson(res, 400, out);
    return writeJson(res, 200, out);
  }

  if (method === "GET" && url.startsWith("/v1/fs/list")) {
    const u = new URL(url, "http://localhost");
    const p = u.searchParams.get("path") ?? ".";
    const out = fsList(ctx.meta.cwd, p);
    if ("error" in out) return writeJson(res, 400, out);
    return writeJson(res, 200, out);
  }

  if (method === "GET" && url.startsWith("/v1/fs/grep")) {
    const u = new URL(url, "http://localhost");
    const pattern = u.searchParams.get("pattern") ?? "";
    const path = u.searchParams.get("path") ?? undefined;
    const flags = u.searchParams.get("flags") ?? undefined;
    const out = fsGrep(ctx.meta.cwd, pattern, { path, flags });
    if ("error" in out) return writeJson(res, 400, out);
    return writeJson(res, 200, out);
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

  // /v1/internal/* — called by `lictor cli permission-hook` (the PreToolUse
  // hook script) and by Concordia's permission-response proxy. Not for hooks
  // running inside claude (those should use /v1/title, /v1/chat, etc.).
  if (method === "POST" && url === "/v1/internal/permission-check") {
    if (!ctx.concordia || !ctx.sessionId) {
      // No Concordia means nobody to ask. Fall through to allow so the
      // wrapped session keeps moving — Lictor never silently denies.
      return writeJson(res, 200, { decision: "allow", reason: "no concordia" });
    }
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as { tool_name?: unknown; tool_input?: unknown; timeout_ms?: unknown };
    if (typeof payload.tool_name !== "string") {
      return writeJson(res, 400, { error: "tool_name (string) required" });
    }
    const requestId = randomUuid();
    const timeoutMs = typeof payload.timeout_ms === "number" && payload.timeout_ms > 0
      ? Math.min(payload.timeout_ms, 600_000)
      : 60_000;

    // Post the request to Concordia so the Web UI modal can show up.
    try {
      await ctx.concordia.permissionRequest(ctx.sessionId, {
        request_id: requestId,
        tool_name: payload.tool_name,
        tool_input: payload.tool_input,
      });
    } catch (err) {
      return writeJson(res, 200, {
        decision: "allow",
        reason: `concordia unreachable (${(err as Error).message})`,
      });
    }

    const decision = await new Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }>((resolve) => {
      const timer = setTimeout(() => {
        ctx.pendingPermissions.delete(requestId);
        resolve({ decision: "allow", reason: "timeout (default-allow)" });
      }, timeoutMs);
      ctx.pendingPermissions.set(requestId, (d) => {
        clearTimeout(timer);
        ctx.pendingPermissions.delete(requestId);
        resolve(d);
      });
    });
    writeJson(res, 200, decision);
    return;
  }

  if (method === "POST" && url === "/v1/internal/permission-response") {
    const body = await readJson(req);
    if (!body.ok) return writeJson(res, 400, { error: body.error });
    const payload = body.value as { request_id?: unknown; decision?: unknown; reason?: unknown };
    if (typeof payload.request_id !== "string") {
      return writeJson(res, 400, { error: "request_id (string) required" });
    }
    if (payload.decision !== "allow" && payload.decision !== "deny" && payload.decision !== "ask") {
      return writeJson(res, 400, { error: "decision must be 'allow', 'deny', or 'ask'" });
    }
    const resolver = ctx.pendingPermissions.get(payload.request_id);
    if (!resolver) {
      return writeJson(res, 404, { error: "no pending request with that id (timed out or unknown)" });
    }
    resolver({
      decision: payload.decision,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    });
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

function randomUuid(): string {
  // Avoid a top-level import just for this — keep sidecar.ts minimal-dep.
  // Node's randomUUID is on `node:crypto`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (globalThis.crypto?.randomUUID?.() as string | undefined) ?? Math.random().toString(36).slice(2);
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

/**
 * Validate a slash-command name. Claude Code recognizes `/clear`,
 * `/compact`, `/help`, `/cost`, `/model`, `/export`, `/rename`, `/init`,
 * `/resume`, etc. All are lowercase ASCII + dash, ≤ 40 chars. Anything
 * else is almost certainly an injection attempt or typo — return null
 * and let the caller 400.
 */
export function sanitizeSlashCmd(cmd: string): string | null {
  const trimmed = cmd.trim().replace(/^\/+/, "").toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Strip dangerous control bytes from a raw keystroke payload, allowing
 * the few that TUIs legitimately need (Enter, Tab, Backspace, DEL, ESC).
 * `\x03` (Ctrl-C / SIGINT) is intentionally dropped — a caller that
 * wanted to interrupt the wrapped claude would use OS signals, not
 * loopback HTTP, and we don't want a stray hook to terminate the user's
 * session by accident.
 */
export function sanitizeKeySeq(data: string): string {
  // Allow: \b (0x08), \t (0x09), \n (0x0a), \r (0x0d), ESC (0x1b),
  //         all printable ≥ 0x20 (incl. DEL 0x7f), all multibyte.
  // Reject: 0x00-0x07, 0x0b, 0x0c, 0x0e-0x1a, 0x1c-0x1f.
  return data.replace(/[\x00-\x07\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, "");
}

/**
 * Build the keystroke sequence needed to pick the Nth option in
 * Claude Code's AskUserQuestion picker (1-indexed).
 *
 *   answer=1                       → just Enter (default is first option)
 *   answer=N (N > 1)               → (N-1) Down-Arrow then Enter
 *
 * `escape_first` prepends ESC, useful when an editor / autocomplete is
 * already open and the picker is one level up the focus stack.
 */
export function buildAnswerSequence(choice: number, escapeFirst = false): string {
  if (!Number.isInteger(choice) || choice < 1 || choice > 50) {
    throw new Error("choice must be an integer in [1, 50]");
  }
  const DOWN = "\x1b[B";
  let seq = "";
  if (escapeFirst) seq += "\x1b";
  seq += DOWN.repeat(choice - 1);
  seq += "\r";
  return seq;
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
