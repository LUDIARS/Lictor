import { test } from "node:test";
import assert from "node:assert/strict";
import { createSubmitWatchdog } from "../src/submit-watchdog.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("submit-watchdog: keeps sending Enter until a user message is observed", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 15 });
  wd.arm();
  await sleep(55);
  wd.noteUserMessage();
  const countAtStop = writes.length;
  await sleep(35);
  assert.ok(countAtStop >= 2, `expected repeated writes, got ${countAtStop}`);
  assert.equal(writes.length, countAtStop);
  assert.deepEqual(writes, Array.from({ length: writes.length }, () => "\r"));
});

test("submit-watchdog: noteUserMessage cancels before first Enter", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 30 });
  wd.arm();
  await sleep(10);
  wd.noteUserMessage();
  await sleep(40);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: timeoutMs<=0 disables watchdog", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 0 });
  wd.arm();
  await sleep(20);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: consecutive arm keeps a single retry loop", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 25 });
  wd.arm();
  await sleep(10);
  wd.arm();
  await sleep(40);
  wd.noteUserMessage();
  assert.equal(writes.length, 1);
});

test("submit-watchdog: stop clears pending retry loop", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 20 });
  wd.arm();
  wd.stop();
  await sleep(40);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: write errors are swallowed and retries continue", async () => {
  let attempts = 0;
  const wd = createSubmitWatchdog({
    write: () => {
      attempts += 1;
      throw new Error("pty gone");
    },
    timeoutMs: 15,
  });
  wd.arm();
  await sleep(35);
  wd.stop();
  assert.ok(attempts >= 1);
});
