/**
 * 許可判断の監査証跡 (JSONL)。
 *
 * 目的は 2 つ:
 *   1. 何が **人間に聞かれずに** 通ったのかを後から数えられるようにする。
 *   2. その中で「settings.json のどの規則にも当たっていないもの」 を抜き出し、
 *      設定の漏れ (= auto mode の動的判断だけで通っているもの) を可視化する。
 *
 * 書き込みは best-effort。 監査が失敗しても許可経路は絶対に止めない。
 * ファイルは日付ごとに 1 本で、 セッション横断で追記する (entry に session_id が入る)。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuleMatch } from "./permission-rules.js";

export type PermissionOutcome =
  /** hook を素通りさせ、 人間に聞かれることなく実行された。 */
  | "auto-allowed"
  /** Claude が許可待ちで停止し、 Cc へカードを出した。 */
  | "prompted"
  /** カードの回答を TUI へ注入した。 */
  | "answered-remote"
  /** 許可待ちを検知したが、 対応する PreToolUse 観測が見つからなかった。 */
  | "notification-unmatched"
  /** Notification の文言が既知のどれでもない (文言変更の疑い)。 */
  | "notification-unknown"
  /** hook を掴んだまま Cc の判断を待った (auto mode 以外)。 */
  | "hook-gated"
  /** Cc へ出せなかった。 */
  | "post-failed";

export interface PermissionAuditEntry {
  ts: string;
  session_id: string | null;
  cwd: string;
  tool: string;
  /** tool_input の要点 (Bash なら command)。 400 字で切る。 */
  summary: string;
  permission_mode: string | null;
  outcome: PermissionOutcome;
  request_id: string;
  /** 当たった settings 規則。 null = どの規則にも載っていない。 */
  rule: RuleMatch | null;
  /** prefix 規則を素通りしうる形の印 (code のみ)。 */
  evasion: string[];
  /** Notification 由来の場合の原文 message。 */
  message?: string;
  decision?: string;
}

export interface PermissionAuditWriter {
  write: (entry: PermissionAuditEntry) => void;
  /** 書き込み先 (診断表示用)。 */
  path: string | null;
}

const SUMMARY_LIMIT = 400;

/** tool_input を 1 行へ要約する。 */
export function summarizeToolInput(toolName: string, toolInput: unknown): string {
  const input = (typeof toolInput === "object" && toolInput !== null ? toolInput : {}) as Record<string, unknown>;
  const pick = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const core =
    pick(input.command) ?? pick(input.file_path) ?? pick(input.path) ?? pick(input.url) ?? pick(input.query);
  const text = core ?? (() => {
    try {
      return JSON.stringify(toolInput ?? {});
    } catch {
      return "";
    }
  })();
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > SUMMARY_LIMIT ? `${flattened.slice(0, SUMMARY_LIMIT)}…` : flattened;
}

/** `permission-audit-YYYY-MM-DD.jsonl` の絶対パス。 */
export function auditPath(dir: string, date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  return join(dir, `permission-audit-${iso}.jsonl`);
}

/** 実ファイルへ追記する writer。 ディレクトリが作れなければ no-op writer になる。 */
export function createPermissionAuditWriter(
  dir: string,
  now: () => Date = () => new Date(),
): PermissionAuditWriter {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { write: () => {}, path: null };
  }
  return {
    path: auditPath(dir, now()),
    write: (entry) => {
      try {
        appendFileSync(auditPath(dir, now()), `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // 監査の失敗で許可経路を止めない。
      }
    },
  };
}
