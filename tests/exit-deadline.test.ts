import { test } from "node:test";
import assert from "node:assert/strict";
import { exitAfterCleanup, DEFAULT_EXIT_DEADLINE_MS } from "../src/exit-deadline.js";

/** 手動で発火できる注入タイマ。 */
function fakeTimer() {
  let pending: { fn: () => void; ms: number } | null = null;
  let cleared = false;
  return {
    setTimeoutFn: (fn: () => void, ms: number) => {
      pending = { fn, ms };
      return "handle";
    },
    clearTimeoutFn: () => {
      cleared = true;
    },
    fire: () => pending?.fn(),
    get scheduledMs() {
      return pending?.ms;
    },
    get cleared() {
      return cleared;
    },
  };
}

test("exits after cleanup resolves, and clears the deadline timer", async () => {
  const timer = fakeTimer();
  const events: string[] = [];
  exitAfterCleanup({
    cleanup: async () => {
      events.push("cleanup");
    },
    exit: () => events.push("exit"),
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["cleanup", "exit"]);
  assert.equal(timer.cleared, true);
  assert.equal(timer.scheduledMs, DEFAULT_EXIT_DEADLINE_MS);
});

test("exits even when cleanup never settles", async () => {
  const timer = fakeTimer();
  const events: string[] = [];
  const warnings: string[] = [];
  exitAfterCleanup({
    cleanup: () => new Promise<void>(() => {}), // 永久に解決しない
    exit: () => events.push("exit"),
    warn: (m) => warnings.push(m),
    deadlineMs: 1234,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  assert.equal(timer.scheduledMs, 1234);
  timer.fire();
  assert.deepEqual(events, ["exit"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /1234ms/);
});

test("exits when cleanup rejects, and reports the reason", async () => {
  const timer = fakeTimer();
  const events: string[] = [];
  const warnings: string[] = [];
  exitAfterCleanup({
    cleanup: async () => {
      throw new Error("unregister blew up");
    },
    exit: () => events.push("exit"),
    warn: (m) => warnings.push(m),
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["exit"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /unregister blew up/);
});

test("exit is called at most once when the deadline races cleanup", async () => {
  const timer = fakeTimer();
  const events: string[] = [];
  exitAfterCleanup({
    cleanup: async () => {},
    exit: () => events.push("exit"),
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  await new Promise((resolve) => setImmediate(resolve));
  timer.fire();
  assert.deepEqual(events, ["exit"]);
});
