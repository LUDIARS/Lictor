/**
 * `lictor cli session-id-hook` — Claude Code SessionStart hook bridge.
 *
 * Lictor が `--settings` で注入する SessionStart hook。 claude は起動時 /
 * `/clear` / resume / compact のたびにこの hook を発火させるので、 hook stdin の
 * 現 `session_id` を `<stateDir>/claude-session-<lictorId>.txt` に書き出す。
 *
 * 目的: `--session-id` で固定した transcript JSONL は `/clear` で別 uuid の新
 * JSONL にローテートするが、 transcript-tail は固定ファイルを掴んだまま再
 * discover しないため Concordia への transcript 中継が止まる。 この hook が
 * 「現在の claude session id」 を state ファイルに書き、 transcript-tail がそれを
 * poll して新 JSONL へ再 pin できるようにする (`maybeRepin`)。
 *
 * SessionStart hook は失敗してもセッション起動を止めてはならないので、 全エラーを
 * 飲み込み常に exit 0 / stdout 無出力で抜ける。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { claudeSessionStatePath, resolveActiveReposDir } from "./active-repos.js";

interface HookInput {
  session_id?: string;
}

/** stdin を読み切る. hook の stdin が来ない異常系で固まらないよう短い timeout 付き. */
async function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = (v: string) => resolve(v);
    const timer = setTimeout(() => done(Buffer.concat(chunks).toString("utf8")), timeoutMs);
    timer.unref?.();
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function runSessionIdHook(): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as HookInput;
    const sid = (input.session_id ?? "").trim();
    if (!sid) return;
    // Lictor が spawn 時に env export 済 (wrap.ts: env.LICTOR_SESSION_ID = concordia.id)。
    // 非 Lictor 起動の claude では未設定 → no-op (この hook は Lictor 注入時のみ意味を持つ)。
    const lictorId = (process.env.LICTOR_SESSION_ID ?? "").trim();
    if (!lictorId) return;
    const stateDir = resolveActiveReposDir();
    const path = claudeSessionStatePath(stateDir, lictorId);
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      /* best-effort — 既存 / 権限 */
    }
    writeFileSync(path, sid, "utf8");
  } catch {
    // SessionStart hook は絶対に起動をブロックしない。
  }
}
