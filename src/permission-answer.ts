/**
 * 許可ダイアログへのリモート回答 (キーストローク注入)。
 *
 * Notification 起点の許可要求では PreToolUse hook を掴んでいない
 * (全 permission mode で decision を返さず素通ししている)。 つまり HTTP 応答で
 * 許可を返す経路が無く、 Discord / Web UI の回答は **開いている TUI ダイアログ**
 * へ打鍵で届けるしかない。 これは `ask-question-relay` と同じ第 2 trust boundary
 * なので、 生の外部入力を pty へ流さず、 ここで生成した固定シーケンスだけを使う。
 *
 * Claude Code の許可ダイアログの並び:
 *   1. Yes
 *   2. Yes, and don't ask again …   (ツールによっては出ない)
 *   3. No, and tell Claude what to do differently (esc)
 *
 * 「2 が出ないツールがある」ため、選択肢を移動する回答は扱わない。
 * deny は選択位置に依存しない ESC を使う。
 */

export type PermissionAnswer = "allow" | "deny";

const ENTER = "\r";
const ESCAPE = "\x1b";

/** Cc から届く decision 文字列を、 注入できる回答へ正規化する。 */
export function toPermissionAnswer(decision: unknown): PermissionAnswer | null {
  if (decision === "allow" || decision === "deny") return decision;
  // "ask" は「人間が TUI で決める」 の意味。 注入しない。
  return null;
}

/**
 * 回答に対応する打鍵列を返す。
 *
 * allow        — 既定選択 (1. Yes) のまま Enter。 選択位置を動かさないので
 *                ダイアログの選択肢構成が変わっても誤爆しない。
 * deny         — ESC。 「拒否してモデルに指示し直す」 に落ちる。
 */
export function buildPermissionAnswerSequence(answer: PermissionAnswer): string {
  switch (answer) {
    case "allow":
      return ENTER;
    case "deny":
      return ESCAPE;
  }
}
