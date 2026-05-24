/**
 * Tail Claude Code's session JSONL and relay each line to Concordia as a
 * `transcript-frame`. Lets a remote viewer (Concordia Web UI) see what the
 * wrapped session is doing without parsing the TUI output.
 *
 * Discovery: Claude writes its session to
 *   ~/.claude/projects/<cwdEncoded>/<claude-session-uuid>.jsonl
 * The UUID isn't exposed to the parent process, so we discover the file by
 * watching the projects/<cwdEncoded>/ directory after spawn and picking
 * the .jsonl that is created or modified within a short grace window. This
 * is the same trick HAPPY uses for its local-mode transcript ingest.
 *
 * Polling vs fs.watch: Windows fs.watch fires inconsistently on append-only
 * files (sometimes only on rename / close), so we use a 500ms poll loop to
 * detect size changes. The poll is cheap because we're only stat()-ing one
 * file. Cheap enough that on cleanup we just clearInterval.
 *
 * Backpressure: POST to Concordia is fire-and-forget. If Concordia is
 * unreachable, the frame is dropped — there is no in-process queue. The
 * Web UI re-reads the JSONL via session detail GETs if it wants history.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { cwdToProjectKey } from "./memory-loader.js";

const DISCOVERY_WINDOW_MS = 30_000; // pick a .jsonl created/modified within 30s of start
const POLL_INTERVAL_MS = 500;
const POST_TIMEOUT_MS = 2000;

export interface TranscriptTailHandle {
  stop: () => void;
}

export interface TranscriptTailOptions {
  cwd: string;
  sessionId: string;
  concordiaBaseUrl: string;
}

export function startTranscriptTail(opts: TranscriptTailOptions): TranscriptTailHandle {
  const dir = join(homedir(), ".claude", "projects", cwdToProjectKey(opts.cwd));
  let jsonlPath: string | null = null;
  let offset = 0;
  let seq = 0;
  let pending = "";
  let stopped = false;
  const startedAt = Date.now();

  const discover = (): string | null => {
    if (!existsSync(dir)) return null;
    let best: { path: string; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        const mtimeMs = st.mtimeMs;
        // Only consider files touched after lictor started (avoids resuming
        // old sessions that happen to live in the same project dir).
        if (mtimeMs < startedAt - 5_000) continue;
        if (Date.now() - mtimeMs > DISCOVERY_WINDOW_MS) continue;
        if (!best || mtimeMs > best.mtime) best = { path: p, mtime: mtimeMs };
      } catch {
        // file vanished between readdir + stat — ignore
      }
    }
    return best?.path ?? null;
  };

  const pollOnce = async (): Promise<void> => {
    if (stopped) return;
    if (!jsonlPath) {
      jsonlPath = discover();
      if (!jsonlPath) return;
      offset = 0;
    }
    let size: number;
    try {
      size = statSync(jsonlPath).size;
    } catch {
      return; // file went away
    }
    if (size <= offset) return;
    let chunk: Buffer;
    try {
      const fd = readFileSync(jsonlPath); // small per-poll; OK in v1
      chunk = fd.subarray(offset, size) as Buffer;
    } catch {
      return;
    }
    offset = size;
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = lineToFrame(line);
      if (!frame) continue;
      const seqNum = seq++;
      void postFrame(opts.concordiaBaseUrl, opts.sessionId, seqNum, frame.kind, frame.payload);
    }
  };

  const timer = setInterval(() => {
    void pollOnce().catch(() => {});
  }, POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

interface Frame { kind: string; payload: unknown }

/**
 * Convert one JSONL line (a SDKMessage from claude-agent-sdk) into the
 * slim envelope Concordia broadcasts. The full SDK message is heavy and
 * not currently rendered by the Web UI; we extract the most relevant
 * fields per common type. Unknown types fall through to `raw`.
 */
export function lineToFrame(line: string): Frame | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;

  // Claude Code session JSONL stores conversation messages with shapes like:
  //   {type: "user",      message: {role, content: [{type, text|...}]}}
  //   {type: "assistant", message: {role, content: [...]}}
  //   {type: "summary"|"system"|"tool_use_result"|...}
  const type = typeof msg.type === "string" ? msg.type : "unknown";

  if (type === "user" || type === "assistant") {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          return { kind: "text", payload: { role: type, text: part.text } };
        }
        if (part?.type === "tool_use") {
          return {
            kind: "tool-use",
            payload: { role: type, name: part.name, input_preview: previewJson(part.input) },
          };
        }
        if (part?.type === "tool_result") {
          return {
            kind: "tool-result",
            payload: {
              tool_use_id: part.tool_use_id,
              is_error: part.is_error === true,
              preview: previewJson(part.content),
            },
          };
        }
        if (part?.type === "thinking" && typeof part.thinking === "string") {
          return { kind: "thinking", payload: { role: type, preview: part.thinking.slice(0, 400) } };
        }
      }
    } else if (typeof content === "string") {
      return { kind: "text", payload: { role: type, text: content } };
    }
    return null;
  }

  if (type === "summary") {
    return { kind: "summary", payload: { text: String(msg.summary ?? "").slice(0, 400) } };
  }

  if (type === "system") {
    return { kind: "system", payload: { text: String(msg.text ?? msg.content ?? "").slice(0, 400) } };
  }

  return { kind: "raw", payload: { type, keys: Object.keys(msg).slice(0, 8) } };
}

function previewJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 200);
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return "[unserializable]";
  }
}

async function postFrame(
  baseUrl: string,
  sessionId: string,
  seq: number,
  kind: string,
  payload: unknown,
): Promise<void> {
  const url = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/transcript-frame`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq, kind, payload }),
      signal: ctrl.signal,
    });
  } catch {
    // best-effort
  } finally {
    clearTimeout(timer);
  }
}
