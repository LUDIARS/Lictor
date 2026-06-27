/**
 * `lictor cli session-id-hook` — Claude Code SessionStart hook bridge.
 *
 * Lictor が `--settings` で注入する SessionStart hook。 claude は起動時 /
 * `/clear` / resume / compact のたびにこの hook を発火させるので、 hook stdin の
 * 現 `session_id` を `<stateDir>/claude-session-<lictorId>.txt` に書き出す
 * (active-repos watcher 等が lictorId → 現 claude sid を引く用)。
 *
 * 加えて hook payload の `transcript_path` (= claude が実際に書き出している transcript
 * JSONL の絶対パス) を `<stateDir>/claude-transcript-<lictorId>.txt` に書き出す。 これが
 * transcript-tail が「どの JSONL を tail すべきか」 を決める **権威ソース** になる。
 *
 * 目的: `--session-id` で固定しても、 現行 Claude Code は渡した uuid と実 JSONL の
 * ファイル名 uuid が一致しないことがあり、 computed pin (`<uuid>.jsonl`) を待つだけだと
 * 中継が一切始まらない。 また `/clear` で別 uuid の新 JSONL にローテートすると掴んだ
 * ファイルが死ぬ。 hook が報告する実 transcript_path を読めば、 ファイル名不一致でも実
 * ファイルを束縛でき、 ローテートにも追従でき、 mtime 推測 (別セッション混入の crosstalk
 * 源) を完全に排除できる。 transcript-tail 側の追従は `maybeRebind`。
 *
 * SessionStart hook は失敗してもセッション起動を止めてはならないので、 全エラーを
 * 飲み込み常に exit 0 / stdout 無出力で抜ける。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeSessionStatePath,
  claudeTranscriptStatePath,
  resolveActiveReposDir,
} from "./active-repos.js";

/**
 * 過剰ログ (verbose-logging-bootstrap): SessionStart hook が claude から実際に受け取った
 * payload (session_id / transcript_path / source) と、 報告された transcript_path が
 * ディスクに実在するかを `<stateDir>/lictor-hook-debug.log` へ追記する。 transcript が
 * 永続化されない / phantom path が報告される現象を実セッションで裏取りするための入口。
 * 安定後に撤去 PR で消す。 LICTOR_DEBUG_TRANSCRIPT=0 で無効化。
 */
function debugLog(stateDir: string, line: string): void {
  if (process.env.LICTOR_DEBUG_TRANSCRIPT === "0") return;
  try {
    appendFileSync(join(stateDir, "lictor-hook-debug.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best-effort */
  }
}

interface HookInput {
  session_id?: string;
  /** claude が書き出している transcript JSONL の絶対パス (SessionStart hook payload)。 */
  transcript_path?: string;
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
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      /* best-effort — 既存 / 権限 */
    }
    writeFileSync(claudeSessionStatePath(stateDir, lictorId), sid, "utf8");
    // transcript JSONL の実パス (権威ソース)。 hook payload が持つときだけ書き出す。
    // transcript-tail はこれを読んで tail 対象を束縛する (mtime 推測を排除)。
    const transcriptPath = (input.transcript_path ?? "").trim();
    if (transcriptPath) {
      writeFileSync(claudeTranscriptStatePath(stateDir, lictorId), transcriptPath, "utf8");
    }
    // 過剰ログ: claude が報告した payload と、 報告 transcript_path の実在を裏取りする。
    // 「transcript が永続化されない / phantom path 報告」 を実セッションで確認するための核心ログ。
    debugLog(
      stateDir,
      `lictorId=${lictorId} source=${(input as { source?: string }).source ?? "?"} ` +
        `session_id=${sid} transcript_path=${transcriptPath || "(none)"} ` +
        `transcriptExists=${transcriptPath ? existsSync(transcriptPath) : "n/a"}`,
    );
  } catch {
    // SessionStart hook は絶対に起動をブロックしない。
  }
}
