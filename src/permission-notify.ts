/**
 * Claude Code `Notification` hook の message 分類。
 *
 * PreToolUse は「ツールを呼ぶたび」 に発火するので、 許可 UI の発火点としては
 * 使えない (全コマンドでカードが出る)。 一方 Notification hook は
 * **Claude が実際に人間の入力待ちで停止したとき** にしか発火しないので、
 * 「設定に関わらず許可が要るものだけ」 を選り分けられる。
 *
 * message の文言はバージョンで揺れるため、 判定は緩いパターンで行い、
 * どれにも当たらなかった message は `unknown` として監査ログに残す
 * (文言変更を沈黙で握りつぶさない)。
 */

export type NotificationKind = "permission" | "idle" | "unknown";

export interface NotificationClassification {
  kind: NotificationKind;
  /** message から読めたツール名 (例 "Bash")。 読めなければ null。 */
  toolName: string | null;
}

/** "Claude needs your permission to use Bash" 等。 */
const PERMISSION_PATTERN = /permission/i;
/** "Claude is waiting for your input" 等 — 60s 無操作の催促であって許可要求ではない。 */
const IDLE_PATTERN = /waiting for your input|idle/i;
/** ツール名は "to use <Tool>" の後ろに出る。 mcp__ 系も拾えるようにする。 */
const TOOL_PATTERN = /to use\s+([A-Za-z_][\w.-]*)/;

export function classifyNotification(message: unknown): NotificationClassification {
  if (typeof message !== "string" || message.trim() === "") {
    return { kind: "unknown", toolName: null };
  }
  const toolName = TOOL_PATTERN.exec(message)?.[1] ?? null;
  // 許可判定を先に見る。 "permission" を含む message は待機催促ではない。
  if (PERMISSION_PATTERN.test(message)) return { kind: "permission", toolName };
  if (IDLE_PATTERN.test(message)) return { kind: "idle", toolName };
  return { kind: "unknown", toolName };
}
