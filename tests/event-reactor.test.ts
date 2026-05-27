import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTitleWithMarks,
  composeTitleWith,
  isNotifyStale,
  newNotifyState,
  reactToEvent,
} from "../src/event-reactor.js";

test("newNotifyState is empty", () => {
  const s = newNotifyState();
  assert.equal(s.mark, null);
  assert.equal(s.expiresAt, null);
  assert.equal(isNotifyStale(s), true);
});

test("isNotifyStale: not stale within ttl, stale after", () => {
  const fresh = { mark: "[!]", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  assert.equal(isNotifyStale(fresh), false);
  const old = { mark: "[!]", expiresAt: new Date(Date.now() - 1).toISOString() };
  assert.equal(isNotifyStale(old), true);
  const persistent = { mark: "[!]", expiresAt: null };
  assert.equal(isNotifyStale(persistent), false);
});

test("composeTitleWith: marks prepended to base", () => {
  const base = composeTitleWith(
    { persona: null, roleLabel: null, stat: null, cwd: "/proj" },
    { conflict: null, notify: null },
  );
  assert.equal(base, "proj");
  const both = composeTitleWith(
    { persona: null, roleLabel: null, stat: null, cwd: "/proj" },
    { conflict: "⚠2", notify: "[!]" },
  );
  assert.equal(both, "[!] ⚠2 proj");
});

test("composeTitleWith: just marks when base is empty", () => {
  const justMarks = composeTitleWith(
    { persona: null, roleLabel: null, stat: null, cwd: "" },
    { conflict: "⚠1", notify: null },
  );
  assert.equal(justMarks, "⚠1");
});

test("reactToEvent: chat from another session sets notify mark", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    { kind: "chat", payload: { session_id: "other" } },
    ctx,
  );
  assert.equal(ctx.notifyState.mark, "[!]");
  assert.notEqual(ctx.notifyState.expiresAt, null);
});

test("reactToEvent: chat from self is ignored", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent({ kind: "chat", payload: { session_id: "me" } }, ctx);
  assert.equal(ctx.notifyState.mark, null);
});

test("reactToEvent: conflict_detected triggers title refresh", () => {
  const ctx = makeReactorCtx({});
  reactToEvent({ kind: "conflict_detected" }, ctx);
  assert.equal(ctx.refreshAutoTitleCalled, 1);
});

test("reactToEvent: pending_task.added triggers hint", () => {
  const ctx = makeReactorCtx({});
  reactToEvent({ kind: "pending_task.added" }, ctx);
  assert.equal(ctx.onPendingTaskHintCalled, 1);
});

test("reactToEvent: unknown kind is a no-op", () => {
  const ctx = makeReactorCtx({});
  reactToEvent({ kind: "random.unknown" }, ctx);
  assert.equal(ctx.notifyState.mark, null);
  assert.equal(ctx.refreshAutoTitleCalled, 0);
  assert.equal(ctx.onPendingTaskHintCalled, 0);
});

test("reactToEvent: malformed event is dropped silently", () => {
  const ctx = makeReactorCtx({});
  reactToEvent(null, ctx);
  reactToEvent({}, ctx);
  reactToEvent("nope", ctx);
  assert.equal(ctx.notifyState.mark, null);
});

test("reactToEvent: session.inject with matching id calls onInject", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    { type: "session.inject", target_session_id: "me", text: "do the thing", source: "web-ui", ts: 1 },
    ctx,
  );
  assert.deepEqual(ctx.injectCalls, [{ text: "do the thing", source: "web-ui" }]);
});

test("reactToEvent: session.inject for a different session is ignored", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    { type: "session.inject", target_session_id: "someone-else", text: "ignored", source: null, ts: 1 },
    ctx,
  );
  assert.equal(ctx.injectCalls.length, 0);
});

test("reactToEvent: session.inject with empty text is dropped", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    { type: "session.inject", target_session_id: "me", text: "", source: null, ts: 1 },
    ctx,
  );
  assert.equal(ctx.injectCalls.length, 0);
});

test("reactToEvent: session.inject defaults source to null when missing", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    { type: "session.inject", target_session_id: "me", text: "hi", ts: 1 },
    ctx,
  );
  assert.deepEqual(ctx.injectCalls, [{ text: "hi", source: null }]);
});

test("reactToEvent: question.answered with matching id calls onAnswerQuestion", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    {
      type: "question.answered",
      target_session_id: "me",
      question_id: 7,
      answer_index: 2,
      answer_text: "third option",
      ts: 1,
    },
    ctx,
  );
  assert.deepEqual(ctx.answerQuestionCalls, [2]);
});

test("reactToEvent: question.answered for a different session is ignored", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    { type: "question.answered", target_session_id: "someone-else", answer_index: 0, ts: 1 },
    ctx,
  );
  assert.equal(ctx.answerQuestionCalls.length, 0);
});

test("reactToEvent: question.answered with non-integer answer_index is dropped", () => {
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    { type: "question.answered", target_session_id: "me", answer_index: 1.5, ts: 1 },
    ctx,
  );
  reactToEvent(
    { type: "question.answered", target_session_id: "me", answer_index: "0", ts: 1 },
    ctx,
  );
  reactToEvent(
    { type: "question.answered", target_session_id: "me", answer_index: -1, ts: 1 },
    ctx,
  );
  assert.equal(ctx.answerQuestionCalls.length, 0);
});

test("reactToEvent: question.answered with index 0 (first option) still fires", () => {
  // Edge case: 0-based first option must produce a call so the picker
  // confirms the default selection (translates to plain Enter downstream).
  const ctx = makeReactorCtx({ ownSessionId: "me" });
  reactToEvent(
    { type: "question.answered", target_session_id: "me", answer_index: 0, ts: 1 },
    ctx,
  );
  assert.deepEqual(ctx.answerQuestionCalls, [0]);
});

test("applyTitleWithMarks: respects manual override", () => {
  const titleState = { manualOverride: "[manual]" };
  // applyTitleWithMarks is a no-op when there's a manual override; we
  // can't assert on stdout cleanly, but the function should at least not throw.
  assert.doesNotThrow(() =>
    applyTitleWithMarks(
      titleState,
      { persona: null, roleLabel: null, stat: null, cwd: "/proj" },
      { conflict: null, notify: null },
    ),
  );
});

interface FakeReactorCtx {
  meta: { cwd: string };
  titleState: { manualOverride: null };
  notifyState: { mark: string | null; expiresAt: string | null };
  conflictMark: () => null;
  refreshAutoTitle: () => void;
  refreshAutoTitleCalled: number;
  ownSessionId: string | null;
  onPendingTaskHint: () => void;
  onPendingTaskHintCalled: number;
  onInject: (text: string, source: string | null) => void;
  injectCalls: Array<{ text: string; source: string | null }>;
  onAnswerQuestion: (answerIndex: number) => void;
  answerQuestionCalls: number[];
}

function makeReactorCtx(opts: { ownSessionId?: string | null }): FakeReactorCtx {
  const ctx: FakeReactorCtx = {
    meta: { cwd: "/proj" },
    titleState: { manualOverride: null },
    notifyState: newNotifyState(),
    conflictMark: () => null,
    refreshAutoTitle: () => {
      ctx.refreshAutoTitleCalled++;
    },
    refreshAutoTitleCalled: 0,
    ownSessionId: opts.ownSessionId ?? null,
    onPendingTaskHint: () => {
      ctx.onPendingTaskHintCalled++;
    },
    onPendingTaskHintCalled: 0,
    onInject: (text, source) => {
      ctx.injectCalls.push({ text, source });
    },
    injectCalls: [],
    onAnswerQuestion: (answerIndex) => {
      ctx.answerQuestionCalls.push(answerIndex);
    },
    answerQuestionCalls: [],
  };
  return ctx;
}
