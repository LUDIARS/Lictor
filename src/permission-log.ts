/**
 * 許可経路の stderr 側ログ (wrapper 自身の診断用)。
 *
 * 正本の監査証跡は `permission-audit.ts` の JSONL。 こちらは Concordia も
 * ファイルも介さずに wrapper のログへ出るので、 「カードが出た / 出なかった」 の
 * 挙動をその場で追える。
 */

export type PermissionLogAction =
  /** PreToolUse を記録して hook を解放した。 */
  | "deferred"
  /** 許可待ちを検知して Concordia へ投稿した。 */
  | "posted-immediately"
  /** カードの回答を TUI へ注入した。 */
  | "answered"
  /** Concordia へ投稿できなかった。 */
  | "post-failed";

export interface PermissionLogEntry {
  action: PermissionLogAction;
  request_id: string;
  tool_name: string;
  deferred_ms: number;
  error?: string;
}

export function writePermissionLog(entry: PermissionLogEntry): void {
  try {
    process.stderr.write(`${JSON.stringify({ event: "permission-check", ...entry })}\n`);
  } catch {
    // Local audit logging must not interfere with the permission path.
  }
}
