/**
 * src/exit-deadline.ts — 終了経路の後片付けに締め切りを付ける。
 *
 * WHY: wrapper の終了は `cleanup()` (transcript flush / session リソース削除 /
 * Concordia unregister) を待ってから `process.exit` する。 この cleanup が
 * 1 つでも解決しない promise を含むと exit に到達せず、 子 (AI CLI) が死んだ後も
 * lictor の node プロセスが OS 上に残り続ける (2026-08-10 実測: 完了済み委託の
 * ラッパが子 0 本のまま数時間生存)。
 *
 * 個々の呼び出しに timeout を足すのは必要だが十分ではない — 「どこか 1 つ漏れたら
 * 永久に残る」構造自体を断つため、 cleanup 全体に締め切りを掛けて exit を保証する。
 *
 * SRP: 「cleanup を待つ / 締め切ったら諦める / exit を高々 1 回呼ぶ」だけ。
 * 実際の後片付けと exit 動作は呼び出し側の責務。
 */

/** cleanup を待つ既定の上限。 これを超えたら諦めて終了する。 */
export const DEFAULT_EXIT_DEADLINE_MS = 10_000;

export interface ExitDeadlineOptions {
  /** 後片付け。 reject しても exit は行われる。 */
  cleanup: () => Promise<void>;
  /** 実際の終了動作。 高々 1 回だけ呼ばれる。 */
  exit: () => void;
  /** 締め切り (ms)。 既定 10_000。 */
  deadlineMs?: number;
  /** 締め切り超過や cleanup 失敗の通知先。 */
  warn?: (message: string) => void;
  /** 注入用タイマ (テスト)。 既定 global setTimeout。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** 注入用タイマ解除 (テスト)。 既定 global clearTimeout。 */
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * `cleanup()` の完了を待って `exit()` する。 ただし `deadlineMs` を過ぎたら
 * cleanup の完了を待たずに `exit()` する。 `exit` は高々 1 回しか呼ばれない。
 */
export function exitAfterCleanup(options: ExitDeadlineOptions): void {
  const deadlineMs = options.deadlineMs ?? DEFAULT_EXIT_DEADLINE_MS;
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const warn = options.warn ?? (() => {});

  let exited = false;
  const finish = (): void => {
    if (exited) return;
    exited = true;
    clearTimeoutFn(handle);
    options.exit();
  };

  const handle = setTimeoutFn(() => {
    if (exited) return;
    warn(`cleanup did not settle within ${deadlineMs}ms — exiting anyway`);
    finish();
  }, deadlineMs);
  // 締め切りタイマ自体が event loop を延命しないようにする。
  (handle as { unref?: () => void })?.unref?.();

  void options
    .cleanup()
    .catch((error: unknown) => {
      warn(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(finish);
}
