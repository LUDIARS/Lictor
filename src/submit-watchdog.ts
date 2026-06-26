/**
 * 文字注入 (provider.submitInject) 後に LLM のターンが始まったかを transcript の
 * user フレーム出現で監視し、 所定時間内に始まらなければ Enter (`\r`) を 1 回
 * 強制送出する watchdog。
 *
 * 背景: Lictor の文字入力は「本文 + `\r` を 1 write」のワンショットで、 TUI が
 * bracketed paste と見なすと `\r` が改行に化けて submit されず入力欄に溜まる
 * (memory: feedback_lictor_keys_text_cr_split)。 submit が成立すると claude は
 * user メッセージを transcript JSONL に書く → transcript-tail が user フレームを
 * 観測する。 これを「発火した」シグナルにし、 来なければ Enter を補って確定させる。
 *
 * 注意: transcript-tail が現セッションの JSONL を正しく追っていることが前提
 * (= `/clear` 後の再 pin が効いていること)。 古い JSONL を掴んだままだと user
 * フレームが永遠に来ず、 毎回スプリアスに `\r` を打つ。 そのため再 pin
 * (maybeRepin) とセットで成立する。
 */

export interface SubmitWatchdog {
  /** submitInject 直後に呼ぶ。 既存タイマーを張り直す。 */
  arm: () => void;
  /** transcript に user メッセージ (= submit 成立) が現れたら呼ぶ。 武装解除。 */
  noteUserMessage: () => void;
  /** cleanup 時に呼ぶ。 保留タイマーを止める。 */
  stop: () => void;
}

export interface SubmitWatchdogOptions {
  /** Enter を流す先 (= ctx.ptyWriter)。 発火時に評価される。 */
  write: (data: string) => void;
  /** user フレーム未観測でこの ms 経過したら `\r` を送る。 0 以下で無効化。 */
  timeoutMs: number;
  /** 観測ログ。 best-effort。 */
  log?: (msg: string) => void;
}

export function createSubmitWatchdog(opts: SubmitWatchdogOptions): SubmitWatchdog {
  let timer: NodeJS.Timeout | null = null;
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    arm: () => {
      if (!(opts.timeoutMs > 0)) return; // 無効化
      clear();
      timer = setTimeout(() => {
        timer = null;
        // user フレーム未観測 = submit されていない → Enter を補う。
        opts.log?.(
          `submit watchdog: no LLM turn ${opts.timeoutMs}ms after inject; forcing Enter`,
        );
        try {
          opts.write("\r");
        } catch {
          /* best-effort — pty 既に消滅等 */
        }
      }, opts.timeoutMs);
      timer.unref?.();
    },
    noteUserMessage: () => clear(),
    stop: () => clear(),
  };
}
