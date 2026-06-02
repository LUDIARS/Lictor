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
 * Pure state machine, no timers — trivially unit-testable. The flush callback
 * is injected so the gate stays decoupled from the pty / provider layer.
 */

/** A pty inject that was held back because a question was open. */
export interface DeferredInject {
  /** Already-sanitized text (TUI-safe; the caller sanitizes before deferring). */
  text: string;
}

export class PendingQuestionGate {
  /** tool_use ids of AskUserQuestion calls currently awaiting an answer. */
  private readonly open = new Set<string>();
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
  openQuestion(id: string): void {
    if (!id) return;
    if (this.open.has(id)) return;
    this.open.add(id);
    this.log(`pending-question-gate: opened (id=${id}, open=${this.open.size})`);
  }

  /**
   * Mark a question resolved (its tool_result was observed). Unknown ids are
   * harmless no-ops, so the caller can pass every tool_result id it sees. When
   * the last open question clears, all held injects are flushed in FIFO order.
   */
  resolveQuestion(id: string): void {
    if (!id) return;
    if (!this.open.delete(id)) return;
    this.log(`pending-question-gate: resolved (id=${id}, open=${this.open.size})`);
    if (!this.isOpen()) this.flushQueue();
  }

  /**
   * Decide what to do with an inbound inject. While a question is open the
   * (already-sanitized) text is held back and `true` is returned so the caller
   * skips writing to the pty. Otherwise `false` — the caller writes normally.
   */
  shouldDefer(text: string): boolean {
    if (!this.isOpen()) return false;
    this.queue.push({ text });
    this.log(`pending-question-gate: deferred inject (queued=${this.queue.length})`);
    return true;
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
