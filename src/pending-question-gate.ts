/**
 * Hold (defer) ordinary pty injects while a Claude `AskUserQuestion` picker
 * is open, then flush them once the picker resolves.
 *
 * ## Why this exists
 *
 * Claude Code's AskUserQuestion picker is a modal TUI list: it has focus and
 * any keystroke is interpreted as picker navigation / filtering, and Enter
 * commits the highlighted option. Lictor relays remote input into the pty in
 * two completely separate ways:
 *
 *   1. `onAnswerQuestion` — a Discord/Web button click → Concordia
 *      `question.answered` → `(N-1)×Down + Enter`. This IS the answer; it must
 *      always reach the picker.
 *   2. `onInject` — a plain Discord chat message routed to the session, the
 *      `/enter` command, the Codex `\n` submit fallback, etc. → Concordia
 *      `session.inject` → `text + \r`.
 *
 * Before this gate existed, case (2) had no idea a picker was open. If the
 * user typed *anything* into the session channel (or any background inject
 * fired) while the picker waited, that text + Enter landed on the picker and
 * committed the **default / wrong** option — Claude moved on, and the question
 * embed that Concordia had just posted to Discord now looked like it arrived
 * "after the fact" (事後). See spec/feature/askquestion-pending-gate.md.
 *
 * ## How it closes
 *
 * The gate opens on the AskUserQuestion `tool_use` id and closes when the
 * matching `tool_result` is observed in the transcript. The picker writing a
 * `tool_result` is the one signal that fires for **both** a remote answer
 * (button) and a local answer (keyboard), so the gate never wedges as long as
 * the session is alive. On wrapper shutdown wrap.ts calls `forceClear()`.
 *
 * ## ask マーカーの質問 (hold policy `"automatic"`)
 *
 * ask マーカー由来の質問は picker ではなく **テキスト出力** なので、任意のキー入力で
 * 誤確定する危険は無い。ここで止めたいのは「人が居ないまま進めと言う自動 inject」
 * (goal-and-go / お伺い / taskflow / Revisor 終局通知) だけ — これが届くとモデルは
 * 自分の質問に自分で答えて先へ進む。そのため marker 質問は **自動 inject のみ保留**し、
 * 人間の発言 (Discord チャット) はそのまま通す。picker 質問は従来どおり全保留
 * (`"all"`) — こちらは人間の 1 文字でもデフォルト候補を確定させてしまうため。
 *
 * marker 質問の gate は明示回答 (`question.answered`) でのみ閉じる。テキストを打った
 * だけでは閉じない = 未回答の質問は blocker として残り、回答するまで自走は進まない。
 *
 * Pure state machine, no timers — trivially unit-testable. The flush callback
 * is injected so the gate stays decoupled from the pty / provider layer.
 */

/** A pty inject that was held back because a question was open. */
export interface DeferredInject {
  /** Already-sanitized text (TUI-safe; the caller sanitizes before deferring). */
  text: string;
}

/**
 * どの inject を保留するか。`"all"` は picker (どんな入力でも誤確定する)、
 * `"automatic"` は ask マーカー (人間の発言は通し、自動 inject だけ止める)。
 */
export type HoldPolicy = "all" | "automatic";

/**
 * 1 件の inject が marker 質問の保留を通り抜けてよいか
 * ({@link ../inject-origin.js bypassesMarkerHold} の結果)。
 */
export interface InjectOrigin {
  bypassesMarkerHold: boolean;
}

/**
 * ask マーカー質問の gate id。picker は Claude の `tool_use` id を使うので、
 * Concordia の question_id (数値) をそのまま混ぜないよう接頭辞で名前空間を分ける。
 */
export function markerGateId(questionId: number): string {
  return `marker:${questionId}`;
}

export class PendingQuestionGate {
  /** 回答待ちの質問 id → その質問が要求する保留の強さ。 */
  private readonly open = new Map<string, HoldPolicy>();
  /** Injects held back while `open` is non-empty, in arrival order (FIFO). */
  private readonly queue: DeferredInject[] = [];

  /**
   * @param flush  Writes one held inject to the pty. Called once per queued
   *               item, in FIFO order, when the last open question resolves.
   * @param log    Optional breadcrumb sink (defaults to no-op). wrap.ts wires
   *               this to stderr so deferred / flushed injects are visible.
   */
  constructor(
    private readonly flush: (text: string) => void,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** True while at least one AskUserQuestion picker is awaiting an answer. */
  isOpen(): boolean {
    return this.open.size > 0;
  }

  /** Number of injects currently held back (for tests / diagnostics). */
  get deferredCount(): number {
    return this.queue.length;
  }

  /**
   * Mark an AskUserQuestion picker as open. Idempotent (a multi-question
   * AskUserQuestion call shares one tool_use id, and a re-read of the same
   * transcript line must not double-count). Empty ids are ignored — without a
   * real id we couldn't pair the matching tool_result, so gating on it would
   * risk a permanent hold.
   */
  openQuestion(id: string, policy: HoldPolicy = "all"): void {
    if (!id) return;
    if (this.open.has(id)) return;
    this.open.set(id, policy);
    this.log(`pending-question-gate: opened (id=${id}, policy=${policy}, open=${this.open.size})`);
  }

  /**
   * Mark a question resolved — picker なら tool_result 観測時、marker なら明示回答
   * (`question.answered`) 時。Unknown ids are harmless no-ops, so the caller can
   * pass every tool_result id it sees. When the last open question clears, all
   * held injects are flushed in FIFO order.
   */
  resolveQuestion(id: string): void {
    if (!id) return;
    if (!this.open.delete(id)) return;
    this.log(`pending-question-gate: resolved (id=${id}, open=${this.open.size})`);
    if (!this.isOpen()) this.flushQueue();
  }

  /**
   * Decide what to do with an inbound inject. While a question that holds this
   * kind of inject is open, the (already-sanitized) text is held back and `true`
   * is returned so the caller skips writing to the pty. Otherwise `false` — the
   * caller writes normally.
   *
   * 人間の発言 / 終了指示は `origin.bypassesMarkerHold` で通過を要求できるが、picker
   * 質問 (`"all"`) が 1 件でも開いていれば誰の入力でも保留する — picker は入力そのもので
   * 誤確定するため。
   */
  shouldDefer(text: string, origin: InjectOrigin = { bypassesMarkerHold: false }): boolean {
    if (!this.holdsInject(origin)) return false;
    this.queue.push({ text });
    this.log(
      `pending-question-gate: deferred inject (bypass=${origin.bypassesMarkerHold}, queued=${this.queue.length})`,
    );
    return true;
  }

  /** この出どころの inject を保留する質問が開いているか。 */
  private holdsInject(origin: InjectOrigin): boolean {
    for (const policy of this.open.values()) {
      if (policy === "all") return true;
      if (!origin.bypassesMarkerHold) return true;
    }
    return false;
  }

  /**
   * Drop all open questions and any held injects without flushing. Used on
   * wrapper shutdown / transcript-tail stop, where flushing into a dying pty
   * (or a still-open picker we can no longer track) would do more harm than
   * good.
   */
  forceClear(): void {
    if (this.open.size === 0 && this.queue.length === 0) return;
    this.log(
      `pending-question-gate: force-clear (dropped open=${this.open.size}, queued=${this.queue.length})`,
    );
    this.open.clear();
    this.queue.length = 0;
  }

  private flushQueue(): void {
    if (this.queue.length === 0) return;
    this.log(`pending-question-gate: flushing ${this.queue.length} held inject(s)`);
    // Splice up front so a flush() that somehow re-enters can't double-send.
    const pending = this.queue.splice(0, this.queue.length);
    for (const item of pending) this.flush(item.text);
  }
}
