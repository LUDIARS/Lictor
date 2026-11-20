import { homedir } from "node:os";
import { join } from "node:path";
import { AgyConversationLog, bindAgyConversation, readPresence, type AgyConversation } from "./agy-binding.js";
import { readAgyRows } from "./agy-database.js";
import { AgyTerminalStatus, type AgyLaunch } from "./agy-pty.js";
import { AgyTurns } from "./agy-turns.js";
import type { TranscriptFrameInput } from "./transcript-sink.js";
import type { TranscriptReadResult, TranscriptTailHandle } from "./transcript-tail.js";

interface AgyTranscriptOptions {
  launch: AgyLaunch;
  cwd: string;
  send: (frame: TranscriptFrameInput) => Promise<void>;
  onUserMessage?: () => void;
  isSessionActive?: () => boolean;
  warn: (message: string) => void;
  root?: string;
  pollMs?: number;
}

const BATCH_SIZE = 32;
const RECENT_LIMIT = 500;
const UNBOUND_GRACE_MS = 15_000;

export function startAgyTranscript(opts: AgyTranscriptOptions): TranscriptTailHandle {
  const root = opts.root ?? join(homedir(), ".gemini", "antigravity-cli");
  const log = new AgyConversationLog(opts.launch.logPath);
  const status = new AgyTerminalStatus();
  const recent: TranscriptFrameInput[] = [];
  const observedIds = new Set<string>();
  let total = 0;
  let conversation: AgyConversation | null = null;
  let turns = new AgyTurns(opts.launch.spawnedAt);
  let working = false;
  let terminalReportsProgress = false;
  let terminalDoneAt: number | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let warned = false;
  let activeSince: number | null = null;

  function resolveConversation(): AgyConversation | null {
    const { id, caughtUp } = log.scan();
    if (!caughtUp) return null;
    if (conversation && (id !== conversation.id || readPresence(root, conversation.id)?.identity !== conversation.presenceIdentity)) {
      conversation = null;
      turns = new AgyTurns(opts.launch.spawnedAt);
      recent.length = 0;
      total = 0;
    }
    // The private log can name a successor after /new; an overwritten workspace
    // cache by itself can never change the selected conversation.
    if (!conversation && id && !observedIds.has(id)) {
      conversation = bindAgyConversation(root, opts.cwd, id, opts.launch.spawnedAt);
      if (conversation) observedIds.add(id);
    }
    return conversation;
  }

  async function poll(): Promise<void> {
    const now = Date.now();
    if (opts.isSessionActive?.() !== false) activeSince ??= now;
    try {
      const bound = resolveConversation();
      if (bound) {
        const rows = readAgyRows(bound.path, turns.cursor, BATCH_SIZE + 1);
        // The writer may have stopped or switched while the SQLite snapshot was read.
        if (resolveConversation() !== bound) return;
        const frames = turns.consume(rows, BATCH_SIZE, now, terminalDoneAt, !terminalReportsProgress);
        for (const frame of frames) {
          recent.push(frame);
          total++;
          if (recent.length > RECENT_LIMIT) recent.shift();
          if ((frame.payload as { role?: string }).role === "user") opts.onUserMessage?.();
          await opts.send(frame);
        }
        warned = false;
        return;
      }
    } catch {
      // The cache, lock and SQLite schema appear asynchronously. Fail closed and retry.
    }
    if (!warned && activeSince !== null && now - activeSince >= UNBOUND_GRACE_MS) {
      warned = true;
      opts.warn("agy transcript relay is waiting for the session log, matching workspace and an active SQLite conversation");
    }
  }

  function tick(): void {
    if (stopped || inFlight) return;
    inFlight = poll()
      .catch(() => { /* The PTY may be shutting down when a diagnostic is written. */ })
      .finally(() => { inFlight = null; });
  }

  const timer = setInterval(tick, opts.pollMs ?? 300);
  timer.unref();

  return {
    observeTerminal(data) {
      status.push(data, (state) => {
        if (state === "working") {
          terminalReportsProgress = true;
          terminalDoneAt = null;
          working = true;
        } else if (state === "done" && working) {
          working = false;
          terminalDoneAt = Date.now();
          tick();
        } else if (state === "error" || state === "blocked") {
          terminalReportsProgress = true;
          if (state === "error") working = false;
          terminalDoneAt = null;
        }
      });
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    getSessionUuid: () => conversation?.id ?? null,
    getClaudeSessionId: () => conversation?.id ?? null,
    getTranscriptPath: () => conversation?.path ?? null,
    forceRediscover: () => {
      tick();
      return { ok: conversation !== null, path: conversation?.path ?? null };
    },
    readRecent(limit, readOpts): TranscriptReadResult {
      const frames = recent.slice(-Math.max(1, Math.min(limit, RECENT_LIMIT)));
      return {
        path: conversation?.path ?? null,
        available: conversation !== null,
        total_lines: total,
        returned: frames.length,
        ...(readOpts?.raw ? { lines: frames } : { frames }),
      };
    },
  };
}
