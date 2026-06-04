import { setTitle } from "./osc.js";
import type { TitleState } from "./sidecar.js";
import { buildAutoTitle } from "./auto-title.js";
import type { Meta } from "./meta.js";

/**
 * Marks that decorate the auto-title for short-lived attention signals
 * (chat mention, peer activity, etc). Updated by the WS event reactor;
 * read on the next title refresh.
 */
export interface NotifyState {
  /** Short prefix mark like "[!]" or null when clear. */
  mark: string | null;
  /** ISO timestamp after which the mark clears itself. null = persistent. */
  expiresAt: string | null;
}

export function newNotifyState(): NotifyState {
  return { mark: null, expiresAt: null };
}

export function isNotifyStale(state: NotifyState): boolean {
  if (state.mark === null) return true;
  if (state.expiresAt === null) return false;
  return Date.now() > Date.parse(state.expiresAt);
}

export interface ReactorContext {
  meta: Meta;
  titleState: TitleState;
  notifyState: NotifyState;
  conflictMark: () => string | null;
  refreshAutoTitle: () => void;
  ownSessionId: string | null;
  onPendingTaskHint: () => void;
  /**
   * Called when a Concordia `session.inject` event arrives with a matching
   * `target_session_id`. wrap.ts wires this to sanitize the text and write
   * it (plus \r) to the pty so it lands in the wrapped claude as user
   * input. Null when ptyWriter isn't available (smoke harness, pre-spawn).
   */
  onInject?: (text: string, source: string | null) => void;
  /**
   * Called when a Concordia `question.answered` event arrives with a
   * matching `target_session_id`. Carries the Concordia `question_id`, the
   * 0-based `index` (options[] order; -1 for free-text "Other"), and the
   * resolved `text` (single=label / multi=comma-joined labels / Other=free
   * text). wrap.ts routes ask-marker questions to a plain text inject and
   * built-in AskUserQuestion pickers to keystroke confirmation.
   */
  onAnswerQuestion?: (answer: { questionId: number; index: number; text: string }) => void;
}

/**
 * Decode a single WS broadcast and react. Concordia's eventBus event
 * shape is `{kind, payload, ts, ...}` per the API surface — we tolerate
 * unknown kinds and just no-op on them.
 */
export function reactToEvent(ev: unknown, ctx: ReactorContext): void {
  if (!isObject(ev)) return;

  // Concordia events carry their dispatch tag in `type` (modern schema).
  // session.inject is a session-scoped command — match target_session_id
  // against our own id; the WS broadcaster also filters by session, but
  // the local check is belt-and-braces against any future broadcast change.
  if (ev.type === "session.inject") {
    if (typeof ev.target_session_id !== "string") return;
    if (ev.target_session_id !== ctx.ownSessionId) return;
    if (typeof ev.text !== "string" || ev.text.length === 0) return;
    const source = typeof ev.source === "string" ? ev.source : null;
    ctx.onInject?.(ev.text, source);
    return;
  }

  // question.answered — fired when an AskUserQuestion picker is answered
  // remotely (Discord button / Web UI). Concordia carries the 0-based
  // `answer_index` matching the original options[] order. Lictor feeds
  // the same number of Down-Arrows + Enter into the pty so the picker
  // resolves to the same choice locally. Without this branch the picker
  // would just sit there and Claude's tool would never get a result —
  // the user would have to navigate the picker by hand.
  if (ev.type === "question.answered") {
    if (typeof ev.target_session_id !== "string") return;
    if (ev.target_session_id !== ctx.ownSessionId) return;
    if (typeof ev.question_id !== "number" || !Number.isInteger(ev.question_id)) return;
    // index は picker fallback 用 (Other は -1)。text は ask-marker のテキスト回答用。
    const index =
      typeof ev.answer_index === "number" && Number.isInteger(ev.answer_index) ? ev.answer_index : -1;
    const text = typeof ev.answer_text === "string" ? ev.answer_text : "";
    ctx.onAnswerQuestion?.({ questionId: ev.question_id, index, text });
    return;
  }

  const kind = typeof ev.kind === "string" ? ev.kind : null;
  if (!kind) return;
  const payload = isObject(ev.payload) ? ev.payload : {};

  switch (kind) {
    case "chat":
    case "chat.posted":
    case "chat.message": {
      // Surface a brief title mark when another session posts. We don't
      // try to mention-match — any chat in our scope counts as a nudge.
      const from = payload.session_id ?? payload.author_label ?? null;
      if (from && from === ctx.ownSessionId) return; // ignore our own echo
      setNotify(ctx, "[!]", 90_000);
      return;
    }
    case "conflict_detected":
    case "monitor.conflict": {
      // Force-refresh the auto title to pick up the new conflict mark
      // immediately rather than waiting for the next stat cycle.
      ctx.refreshAutoTitle();
      return;
    }
    case "session.pending_task":
    case "pending_task.added":
    case "pending_task.queued": {
      ctx.onPendingTaskHint();
      return;
    }
    case "session.registered":
    case "session.unregistered":
    case "session.lost":
      // Could log; for v0.3 we just no-op to keep terminal output quiet.
      return;
    default:
      return;
  }
}

function setNotify(ctx: ReactorContext, mark: string, ttlMs: number): void {
  ctx.notifyState.mark = mark;
  ctx.notifyState.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  ctx.refreshAutoTitle();
}

/**
 * Build the final title by composing auto title + conflict mark + notify
 * mark. Marks are space-separated prefixes so they're glanceable in
 * Alt+Tab without overwhelming the rest of the title.
 */
export function composeTitleWith(
  baseInputs: Parameters<typeof buildAutoTitle>[0],
  marks: { conflict: string | null; notify: string | null },
): string {
  const base = buildAutoTitle(baseInputs);
  const prefix = [marks.notify, marks.conflict].filter(Boolean).join(" ");
  if (!prefix) return base;
  if (!base) return prefix;
  return `${prefix} ${base}`;
}

export function applyTitleWithMarks(
  titleState: TitleState,
  baseInputs: Parameters<typeof buildAutoTitle>[0],
  marks: { conflict: string | null; notify: string | null },
): void {
  if (titleState.manualOverride !== null) return;
  const title = composeTitleWith(baseInputs, marks);
  if (title) setTitle(title);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
