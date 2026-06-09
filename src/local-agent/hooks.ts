/**
 * ライフサイクル hook 実行。spec/local-llm-agent.md §3。
 * Claude Code の hook 契約のサブセットを模倣し、LUDIARS の hook 生態系
 * (window-title / Concordia 連携など) に乗れるようにする。
 *
 * 全エラーは握りつぶす — hook がローカル LLM セッションを止めてはならない。
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "Stop";

interface HookEntry {
  command: string;
  timeoutMs?: number;
}
type HookMap = Partial<Record<HookEvent, HookEntry[]>>;

const HOOK_EVENTS: HookEvent[] = ["SessionStart", "UserPromptSubmit", "Stop"];
const DEFAULT_TIMEOUT_MS = 10_000;

/** hook 定義 JSON を読む。無い / 壊れている場合は空 (no-op)。 */
export function loadHooks(path: string): HookMap {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const root = (parsed as { hooks?: unknown })?.hooks;
  if (!root || typeof root !== "object") return {};
  const out: HookMap = {};
  for (const ev of HOOK_EVENTS) {
    const arr = (root as Record<string, unknown>)[ev];
    if (!Array.isArray(arr)) continue;
    const entries: HookEntry[] = [];
    for (const item of arr) {
      const cmd = (item as { command?: unknown })?.command;
      if (typeof cmd === "string" && cmd.trim()) {
        const t = (item as { timeoutMs?: unknown })?.timeoutMs;
        entries.push({ command: cmd, timeoutMs: typeof t === "number" && t > 0 ? t : undefined });
      }
    }
    if (entries.length > 0) out[ev] = entries;
  }
  return out;
}

export interface HookContext {
  sessionId: string;
  cwd: string;
  /** UserPromptSubmit のときの入力本文。 */
  prompt?: string;
}

/** 1 コマンドを実行し stdout を返す (timeout / 失敗は空文字)。 */
function runOne(entry: HookEntry, event: HookEvent, ctx: HookContext): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out: string) => {
      if (done) return;
      done = true;
      resolve(out);
    };
    let child;
    try {
      child = spawn(entry.command, { shell: true, windowsHide: true });
    } catch {
      finish("");
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish("");
    }, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); finish(""); });
    child.on("close", () => { clearTimeout(timer); finish(stdout); });

    const payload = JSON.stringify({
      hook_event_name: event,
      session_id: ctx.sessionId,
      cwd: ctx.cwd,
      ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}),
    });
    try {
      child.stdin?.end(payload);
    } catch {
      // stdin が閉じていても close を待つ。
    }
  });
}

/**
 * 指定イベントの hook を順次実行し、stdout を結合して返す。
 * UserPromptSubmit ではこの戻り値を additionalContext として system に足す。
 */
export async function runHooks(event: HookEvent, ctx: HookContext, hooks: HookMap): Promise<string> {
  const entries = hooks[event];
  if (!entries || entries.length === 0) return "";
  const parts: string[] = [];
  for (const e of entries) {
    const out = (await runOne(e, event, ctx)).trim();
    if (out) parts.push(out);
  }
  return parts.join("\n");
}
