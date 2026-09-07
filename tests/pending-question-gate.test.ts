import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingQuestionGate, markerGateId } from "../src/pending-question-gate.js";

test("gate: closed by default — injects pass through (shouldDefer=false)", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  assert.equal(gate.isOpen(), false);
  assert.equal(gate.shouldDefer("hello"), false);
  assert.equal(gate.deferredCount, 0);
  assert.deepEqual(flushed, []);
});

test("gate: while open, injects are held; resolve flushes them in FIFO order", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  gate.openQuestion("q1");
  assert.equal(gate.isOpen(), true);
  assert.equal(gate.shouldDefer("first"), true);
  assert.equal(gate.shouldDefer("second"), true);
  assert.equal(gate.deferredCount, 2);
  assert.deepEqual(flushed, []); // nothing flushed while open

  gate.resolveQuestion("q1");
  assert.equal(gate.isOpen(), false);
  assert.deepEqual(flushed, ["first", "second"]);
  assert.equal(gate.deferredCount, 0);
});

test("gate: openQuestion is idempotent (same id twice = one open)", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  gate.openQuestion("q1");
  gate.openQuestion("q1");
  gate.shouldDefer("x");
  gate.resolveQuestion("q1"); // single resolve clears it
  assert.equal(gate.isOpen(), false);
  assert.deepEqual(flushed, ["x"]);
});

test("gate: multiple distinct questions — flush only after the LAST resolves", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  gate.openQuestion("q1");
  gate.openQuestion("q2");
  gate.shouldDefer("held");
  gate.resolveQuestion("q1");
  assert.equal(gate.isOpen(), true); // q2 still open
  assert.deepEqual(flushed, []);
  gate.resolveQuestion("q2");
  assert.equal(gate.isOpen(), false);
  assert.deepEqual(flushed, ["held"]);
});

test("gate: resolving an unknown id is a no-op and does not flush", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  gate.openQuestion("q1");
  gate.shouldDefer("held");
  gate.resolveQuestion("other"); // not open → ignored
  assert.equal(gate.isOpen(), true);
  assert.deepEqual(flushed, []);
});

test("gate: empty id is ignored (no open, no resolve)", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  gate.openQuestion("");
  assert.equal(gate.isOpen(), false);
  assert.equal(gate.shouldDefer("passes"), false);
});

test("gate: an ask-marker question holds automatic injects but lets humans through", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  gate.openQuestion(markerGateId(42), "automatic");
  // goal-and-go / お伺い / taskflow — 人が居ないまま「進め」と言う inject は保留。
  assert.equal(gate.shouldDefer("goal-and-go", { bypassesMarkerHold: false }), true);
  // Discord チャットの発言は会話を止めないため通す (回答は question.answered 経由)。
  assert.equal(gate.shouldDefer("ちょっと待って", { bypassesMarkerHold: true }), false);
  assert.equal(gate.deferredCount, 1);

  gate.resolveQuestion(markerGateId(42));
  assert.equal(gate.isOpen(), false);
  assert.deepEqual(flushed, ["goal-and-go"]);
});

test("gate: a picker question holds human injects too", () => {
  const gate = new PendingQuestionGate(() => {});
  gate.openQuestion("toolu_1"); // default policy = "all"
  assert.equal(gate.shouldDefer("typed text", { bypassesMarkerHold: true }), true);
});

test("gate: a picker open alongside a marker still holds everything", () => {
  const gate = new PendingQuestionGate(() => {});
  gate.openQuestion(markerGateId(1), "automatic");
  gate.openQuestion("toolu_1", "all");
  assert.equal(gate.shouldDefer("typed text", { bypassesMarkerHold: true }), true);
  gate.resolveQuestion("toolu_1");
  // marker だけが残れば人間の発言は通る。
  assert.equal(gate.shouldDefer("typed again", { bypassesMarkerHold: true }), false);
});

test("gate: marker ids do not collide with picker tool_use ids", () => {
  const gate = new PendingQuestionGate(() => {});
  gate.openQuestion(markerGateId(7), "automatic");
  gate.resolveQuestion("7"); // 生の question_id では閉じない
  assert.equal(gate.isOpen(), true);
  gate.resolveQuestion(markerGateId(7));
  assert.equal(gate.isOpen(), false);
});

test("gate: forceClear drops open questions AND held injects (no flush)", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  gate.openQuestion("q1");
  gate.shouldDefer("dropped");
  gate.forceClear();
  assert.equal(gate.isOpen(), false);
  assert.equal(gate.deferredCount, 0);
  assert.deepEqual(flushed, []);
  // after clear, behaves like a fresh gate
  assert.equal(gate.shouldDefer("now-passes"), false);
});

// --- 素の Enter (制御信号) は marker 保留を通す ---------------------------
// 2026-09-07: 🙄 force-enter / Discord /enter / codex の enter-fallback は
// いずれも source が platform:uid 形式でないため automatic と分類され、
// ask マーカー質問が開いている間 (= 人が「送信されていない」と気付いて救済しに
// 来る、まさにその状況) に握り潰されていた。

test("gate: bare Enter passes a marker question while body text is still held", () => {
  const gate = new PendingQuestionGate(() => {});
  gate.openQuestion(markerGateId(1), "automatic");
  // 本文を持つ automatic inject は従来どおり保留される…
  assert.equal(gate.shouldDefer("goal-and-go", { bypassesMarkerHold: false }), true);
  // …が、それを resolve したあとの素の Enter (救済操作) は通る。
  gate.resolveQuestion(markerGateId(1));
  gate.openQuestion(markerGateId(2), "automatic");
  assert.equal(gate.shouldDefer("\r", { bypassesMarkerHold: false }), false);
});

test("gate: bare CR is not held by a marker question", () => {
  const gate = new PendingQuestionGate(() => {});
  gate.openQuestion(markerGateId(1), "automatic");
  assert.equal(gate.shouldDefer("\r", { bypassesMarkerHold: false }), false);
  assert.equal(gate.deferredCount, 0);
});

test("gate: bare LF and CRLF are treated as Enter too", () => {
  const gate = new PendingQuestionGate(() => {});
  gate.openQuestion(markerGateId(1), "automatic");
  assert.equal(gate.shouldDefer("\n", { bypassesMarkerHold: false }), false);
  assert.equal(gate.shouldDefer("\r\n", { bypassesMarkerHold: false }), false);
  assert.equal(gate.deferredCount, 0);
});

test("gate: bare CR is still held by a picker question", () => {
  const gate = new PendingQuestionGate(() => {});
  gate.openQuestion("toolu_1", "all");
  assert.equal(gate.shouldDefer("\r", { bypassesMarkerHold: false }), true);
});

test("gate: bare CR queues behind already-held body text (FIFO order kept)", () => {
  const flushed: string[] = [];
  const gate = new PendingQuestionGate((t) => flushed.push(t));
  gate.openQuestion(markerGateId(1), "automatic");
  assert.equal(gate.shouldDefer("body", { bypassesMarkerHold: false }), true);
  // 本文が待っている間に Enter だけ先に通すと、flush で順番が壊れる。
  assert.equal(gate.shouldDefer("\r", { bypassesMarkerHold: false }), true);
  gate.resolveQuestion(markerGateId(1));
  assert.deepEqual(flushed, ["body", "\r"]);
});

test("gate: text that merely ends with CR is not treated as a bare Enter", () => {
  const gate = new PendingQuestionGate(() => {});
  gate.openQuestion(markerGateId(1), "automatic");
  assert.equal(gate.shouldDefer("進めてください\r", { bypassesMarkerHold: false }), true);
});
