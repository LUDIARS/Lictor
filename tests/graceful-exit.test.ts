import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleGracefulExit } from "../src/graceful-exit.js";

/** A controllable clock + single-timer harness (the module uses one interval). */
function harness(start = 1_000_000) {
  let now = start;
  let tickFn: (() => void) | null = null;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    setIntervalFn: (fn: () => void) => { tickFn = fn; return { id: 1, unref() {} }; },
    clearIntervalFn: () => { tickFn = null; },
    fireTick: () => tickFn?.(),
    get armed() { return tickFn !== null; },
  };
}

test("kills after the transcript has been idle idleMs", () => {
  const h = harness();
  let lastActivity = h.now();
  let killed = 0;
  scheduleGracefulExit({
    lastActivityMs: () => lastActivity,
    kill: () => { killed++; },
    idleMs: 300_000, maxWaitMs: 1_800_000, checkMs: 30_000,
    now: h.now, setIntervalFn: h.setIntervalFn, clearIntervalFn: h.clearIntervalFn,
  });

  // 4 min idle → not yet
  h.advance(240_000); h.fireTick();
  assert.equal(killed, 0, "should not kill before idle window");

  // still active right now → resets the idle clock
  lastActivity = h.now();
  h.advance(120_000); h.fireTick(); // only 2 min since last activity
  assert.equal(killed, 0, "recent activity defers the kill");

  // now go quiet for 5 min
  h.advance(300_000); h.fireTick();
  assert.equal(killed, 1, "kills once transcript idle >= idleMs");
  assert.equal(h.armed, false, "timer cleared after kill");
});

test("hard cap kills even if transcript never goes idle", () => {
  const h = harness();
  let killed = 0;
  scheduleGracefulExit({
    lastActivityMs: () => h.now(), // always 'just active'
    kill: () => { killed++; },
    idleMs: 300_000, maxWaitMs: 600_000, checkMs: 30_000,
    now: h.now, setIntervalFn: h.setIntervalFn, clearIntervalFn: h.clearIntervalFn,
  });

  h.advance(300_000); h.fireTick();
  assert.equal(killed, 0, "below max-wait, still active → no kill");
  h.advance(300_000); h.fireTick(); // 10 min total >= maxWaitMs
  assert.equal(killed, 1, "max-wait cap forces the kill");
});

test("unknown activity falls back to the request time as baseline", () => {
  const h = harness();
  let killed = 0;
  scheduleGracefulExit({
    lastActivityMs: () => null, // no transcript ever discovered
    kill: () => { killed++; },
    idleMs: 300_000, maxWaitMs: 1_800_000, checkMs: 30_000,
    now: h.now, setIntervalFn: h.setIntervalFn, clearIntervalFn: h.clearIntervalFn,
  });
  h.advance(299_000); h.fireTick();
  assert.equal(killed, 0);
  h.advance(2_000); h.fireTick(); // 301s since request
  assert.equal(killed, 1, "kills idleMs after the request when activity is unknown");
});

test("cancel prevents the deferred kill", () => {
  const h = harness();
  let killed = 0;
  const g = scheduleGracefulExit({
    lastActivityMs: () => null,
    kill: () => { killed++; },
    idleMs: 1_000, maxWaitMs: 2_000, checkMs: 500,
    now: h.now, setIntervalFn: h.setIntervalFn, clearIntervalFn: h.clearIntervalFn,
  });
  g.cancel();
  assert.equal(h.armed, false, "cancel clears the timer");
  h.advance(10_000); h.fireTick();
  assert.equal(killed, 0, "no kill after cancel");
});
