/**
 * 監査 JSONL の集計 (`lictor cli permission-audit`)。
 *
 * 見たいのは 2 種類:
 *   - 規則に載っていないのに自動で通ったもの → settings.json の allow 漏れ候補
 *   - 人間に聞かれたもの (prompted) → 許可 UI が出た実績
 * 迂回フラグ付きは、 規則に当たっていても意図とずれている可能性があるので別枠で出す。
 */

import { readFileSync } from "node:fs";
import { resolveActiveReposDir } from "./active-repos.js";
import { auditPath, type PermissionAuditEntry } from "./permission-audit.js";

export interface AuditGroup {
  tool: string;
  /** コマンドの先頭 2 語 (それ以外のツールは summary の先頭)。 */
  key: string;
  count: number;
  evasion: string[];
  sample: string;
}

export interface AuditSummary {
  total: number;
  autoAllowed: number;
  prompted: number;
  /** どの規則にも当たらずに自動で通ったもの (= 設定漏れ候補)。 */
  unruled: AuditGroup[];
  /** 迂回フラグが付いたもの。 */
  evasive: AuditGroup[];
}

export function parseAuditLines(raw: string): PermissionAuditEntry[] {
  const entries: PermissionAuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as PermissionAuditEntry);
    } catch {
      // 壊れた行は飛ばす (追記の途中で読んだ場合など)。
    }
  }
  return entries;
}

/**
 * 集計キー: Bash はコマンド名 (+ サブコマンドらしき第 2 語)、 それ以外はツール名。
 *
 * 第 2 語をそのまま足すと `curl example.com` / `curl other.com` が別グループになり、
 * 「同じコマンドが何回通ったか」 が見えなくなる。 サブコマンドらしい語
 * (小文字英字始まり・記号やパスを含まない) のときだけ足す。
 */
export function groupKey(entry: PermissionAuditEntry): string {
  if (entry.tool !== "Bash") return entry.tool;
  const words = (entry.summary ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return entry.tool;
  const second = words[1];
  const isSubcommand = second !== undefined && /^[a-z][a-z0-9:_-]*$/.test(second);
  return isSubcommand ? `${words[0]} ${second}` : words[0];
}

function collect(entries: PermissionAuditEntry[]): AuditGroup[] {
  const groups = new Map<string, AuditGroup>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const id = JSON.stringify([entry.tool, key]);
    const existing = groups.get(id);
    if (existing) {
      existing.count += 1;
      for (const flag of entry.evasion ?? []) {
        if (!existing.evasion.includes(flag)) existing.evasion.push(flag);
      }
      continue;
    }
    groups.set(id, {
      tool: entry.tool,
      key,
      count: 1,
      evasion: [...(entry.evasion ?? [])],
      sample: entry.summary,
    });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function summarizeAudit(entries: PermissionAuditEntry[]): AuditSummary {
  // PreToolUse cannot know whether Claude will prompt, so it first appends an
  // auto-allowed candidate. A later Notification appends another event with
  // the same request id. Reconcile those events here so prompted operations
  // are never reported as having run without human confirmation.
  const requestsWithLaterOutcome = new Set(
    entries
      .filter((entry) => entry.outcome !== "auto-allowed" && typeof entry.request_id === "string")
      .map((entry) => entry.request_id),
  );
  const autoAllowed = entries.filter(
    (entry) => entry.outcome === "auto-allowed" && !requestsWithLaterOutcome.has(entry.request_id),
  );
  return {
    total: entries.length,
    autoAllowed: autoAllowed.length,
    prompted: entries.filter((e) => e.outcome === "prompted").length,
    unruled: collect(autoAllowed.filter((e) => e.rule === null)),
    evasive: collect(entries.filter((e) => (e.evasion ?? []).length > 0)),
  };
}

export function formatAuditSummary(summary: AuditSummary): string {
  const lines: string[] = [];
  lines.push(`permission audit: ${summary.total} 件 (自動許可 ${summary.autoAllowed} / 人間確認 ${summary.prompted})`);
  lines.push("");
  lines.push("■ 規則に載っていないまま自動で通ったもの (settings.json allow 漏れ候補)");
  if (summary.unruled.length === 0) lines.push("  (なし)");
  for (const group of summary.unruled.slice(0, 20)) {
    lines.push(`  ${String(group.count).padStart(4)}  ${group.tool}(${group.key})  例: ${group.sample.slice(0, 80)}`);
  }
  lines.push("");
  lines.push("■ prefix 規則を素通りしうる形");
  if (summary.evasive.length === 0) lines.push("  (なし)");
  for (const group of summary.evasive.slice(0, 20)) {
    lines.push(`  ${String(group.count).padStart(4)}  ${group.tool}(${group.key})  [${group.evasion.join(",")}]`);
  }
  return lines.join("\n");
}

/**
 * `lictor cli permission-audit [--date YYYY-MM-DD] [--file <path>]`。
 * 既定は state dir の当日ファイル。
 */
export function reportPermissionAudit(args: string[]): string {
  const fileIndex = args.indexOf("--file");
  if (fileIndex >= 0 && args[fileIndex + 1]) return reportAuditFile(args[fileIndex + 1]);
  const dateIndex = args.indexOf("--date");
  const date = dateIndex >= 0 && args[dateIndex + 1] ? new Date(`${args[dateIndex + 1]}T00:00:00Z`) : new Date();
  if (Number.isNaN(date.getTime())) return "permission audit: --date は YYYY-MM-DD で指定してください";
  return reportAuditFile(auditPath(resolveActiveReposDir(), date));
}

export function reportAuditFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return `permission audit: 読めません (${path}): ${(err as Error).message}`;
  }
  return formatAuditSummary(summarizeAudit(parseAuditLines(raw)));
}
