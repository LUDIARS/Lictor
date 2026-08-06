import { test } from "node:test";
import assert from "node:assert/strict";
import { createSubmitWatchdog } from "../src/submit-watchdog.js";

test("submit-watchdog: keeps sending Enter until a user message is observed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 15 });
  wd.arm();
  t.mock.timers.tick(14);
  assert.deepEqual(writes, []);
  t.mock.timers.tick(1);
  t.mock.timers.tick(15);
  wd.noteUserMessage();
  const countAtStop = writes.length;
  t.mock.timers.tick(100);
  assert.equal(countAtStop, 2);
  assert.equal(writes.length, countAtStop);
  assert.deepEqual(writes, Array.from({ length: writes.length }, () => "\r"));
});

test("submit-watchdog: noteUserMessage cancels before first Enter", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 30 });
  wd.arm();
  t.mock.timers.tick(10);
  wd.noteUserMessage();
  t.mock.timers.tick(100);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: timeoutMs<=0 disables watchdog", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 0 });
  wd.arm();
  t.mock.timers.tick(100);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: consecutive arm keeps a single retry loop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 25 });
  wd.arm();
  t.mock.timers.tick(10);
  wd.arm();
  t.mock.timers.tick(24);
  assert.deepEqual(writes, []);
  t.mock.timers.tick(1);
  wd.noteUserMessage();
  assert.equal(writes.length, 1);
});

test("submit-watchdog: stop clears pending retry loop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 20 });
  wd.arm();
  wd.stop();
  t.mock.timers.tick(100);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: write errors are swallowed and retries continue", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const wd = createSubmitWatchdog({
    write: () => {
      attempts += 1;
      throw new Error("pty gone");
    },
    timeoutMs: 15,
  });
  wd.arm();
  t.mock.timers.tick(15);
  t.mock.timers.tick(15);
  wd.stop();
  assert.equal(attempts, 2);
});
