import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingQuestionGate } from "../src/pending-question-gate.js";

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
