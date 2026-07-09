/**
 * ローカル端末の実キーストローク (= ユーザの「入力意思」) を Concordia に伝える
 * debounced signal。
 *
 * ## なぜ必要か
 *
 * Concordia の idle-nudge (待機催促) は、 セッションが final_answer / summary を
 * 送った後 N 秒 入力が無ければ、 メッセージを送った人に催促通知を出す。 その
 * キャンセル条件の 1 つが「入力意思 (キーボード入力イベント)」だが、 Lictor は
 * ローカルの生キーストロークを Concordia に送っていなかった。 本 signal が
 * wrap.ts の `onStdin` (物理端末 stdin → pty の経路) から呼ばれ、
 * `POST /v1/sessions/:id/event {kind:"user_activity"}` を送る。
 *
 * ## inject と区別する
 *
 * Discord/Web 由来の inject は `submitInject` / `ctx.ptyWriter` で pty に書き込まれる
 * 別経路であり、 本 signal は呼ばれない。 呼ばれるのは物理端末 stdin 由来のみ。
 *
 * ## debounce
 *
 * キーストロークは 1 打鍵ごとに来るため、 高々 `debounceMs` に 1 回だけ実送信する
 * (既定 2000ms)。 送信本体 (`send`) は best-effort で、 失敗は握りつぶす前提
 * (呼び出し側が catch する)。
 *
 * SRP: 間引き判定のみ。 実 HTTP 送信や concordia 参照は呼び出し側が `send` に閉じる。
 */

export interface UserActivitySignalDeps {
  /** 間引きを通過したときに 1 回呼ばれる実送信。 best-effort。 */
  send: () => void;
  /** 時刻プロバイダ (テスト差し替え用)。 既定 Date.now。 */
  now?: () => number;
  /** 実送信の最小間隔 (ms)。 既定 2000。 0 以下なら毎回送る。 */
  debounceMs?: number;
}

/**
 * 「呼ぶたびに、 前回送信から debounceMs 以上経っていれば send() する」 signal を作る。
 * 返り値を onStdin から毎打鍵呼んでよい (間引きは内部で行う)。
 */
export function createUserActivitySignal(deps: UserActivitySignalDeps): () => void {
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? 2000;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (debounceMs > 0 && t - lastSentAt < debounceMs) return;
    lastSentAt = t;
    deps.send();
  };
}
