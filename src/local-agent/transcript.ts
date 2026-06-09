/**
 * 会話ログの永続保存 (JSONL) と resume 復元。spec/local-llm-agent.md §1。
 *
 * 1 セッション = 1 JSONL。message フレームと compaction フレームを追記する。
 * full ログは監査用に全部残るが、resume 時の「live な working set」は
 * 「最後の compaction 以降の message + その要約」だけを復元する
 * (= プロセス再起動でも compaction 後の文脈を正しく引き継ぐ)。
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, ChatRole } from "./ollama.js";

interface MessageFrame {
  ts: number;
  role: ChatRole;
  content: string;
}
interface CompactionFrame {
  ts: number;
  role: "system";
  kind: "compaction";
  summary: string;
  dropped: number;
}
type Frame = MessageFrame | CompactionFrame;

function isCompaction(f: Frame): f is CompactionFrame {
  return (f as CompactionFrame).kind === "compaction";
}

/** transcript ファイルパスを返し、 置き場 dir を作る。 */
export function transcriptPath(sessionsDir: string, sessionId: string): string {
  mkdirSync(sessionsDir, { recursive: true });
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return join(sessionsDir, `${safe}.jsonl`);
}

function append(path: string, frame: Frame): void {
  try {
    appendFileSync(path, JSON.stringify(frame) + "\n", "utf8");
  } catch {
    // 永続化失敗はセッションを止めない (best-effort)。
  }
}

export function appendMessage(path: string, role: ChatRole, content: string): void {
  append(path, { ts: Date.now(), role, content });
}

export function appendCompaction(path: string, summary: string, dropped: number): void {
  append(path, { ts: Date.now(), role: "system", kind: "compaction", summary, dropped });
}

/**
 * resume 用の live working set を復元する (persona system は含めない。
 * 呼び出し側 repl が先頭に足す)。
 *
 * - 最後の compaction フレームがあれば: `[要約 system, ...それ以降の message]`
 * - なければ: 全 message フレーム
 */
export function loadLiveMessages(path: string): ChatMessage[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const frames: Frame[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      frames.push(JSON.parse(s) as Frame);
    } catch {
      // 壊れた行はスキップ (クラッシュ途中の半端行など)。
    }
  }
  let lastCompact = -1;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (isCompaction(frames[i])) {
      lastCompact = i;
      break;
    }
  }
  const out: ChatMessage[] = [];
  if (lastCompact >= 0) {
    const c = frames[lastCompact] as CompactionFrame;
    out.push({ role: "system", content: `これまでの会話の要約:\n${c.summary}` });
    for (let i = lastCompact + 1; i < frames.length; i++) {
      const f = frames[i];
      if (!isCompaction(f)) out.push({ role: f.role, content: f.content });
    }
  } else {
    for (const f of frames) {
      if (!isCompaction(f)) out.push({ role: f.role, content: f.content });
    }
  }
  return out;
}
