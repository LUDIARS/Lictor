import { test } from "node:test";
import assert from "node:assert/strict";
import { createSubmitWatchdog } from "../src/submit-watchdog.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("submit-watchdog: arm 後 timeout で \\r を 1 回送る", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 20 });
  wd.arm();
  await sleep(50);
  assert.deepEqual(writes, ["\r"]);
});

test("submit-watchdog: noteUserMessage で武装解除すると \\r を送らない", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 30 });
  wd.arm();
  await sleep(10);
  wd.noteUserMessage(); // submit 成立 (user フレーム観測)
  await sleep(40);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: timeoutMs<=0 は無効化 (arm しても送らない)", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 0 });
  wd.arm();
  await sleep(20);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: 連続 arm は最後の 1 本だけ生き、 \\r は 1 回", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 25 });
  wd.arm();
  await sleep(10);
  wd.arm(); // 張り直し
  await sleep(45);
  assert.deepEqual(writes, ["\r"]);
});

test("submit-watchdog: stop で保留タイマーを止める", async () => {
  const writes: string[] = [];
  const wd = createSubmitWatchdog({ write: (d) => writes.push(d), timeoutMs: 20 });
  wd.arm();
  wd.stop();
  await sleep(40);
  assert.deepEqual(writes, []);
});

test("submit-watchdog: write が throw しても握り潰す", async () => {
  const wd = createSubmitWatchdog({
    write: () => {
      throw new Error("pty gone");
    },
    timeoutMs: 15,
  });
  wd.arm();
  await sleep(35); // throw が unhandled にならず通過すれば OK
  assert.ok(true);
});
