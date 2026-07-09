import { test } from "node:test";
import assert from "node:assert/strict";
import { createUserActivitySignal } from "../src/user-activity.js";

test("createUserActivitySignal: 最初の呼び出しは即送信", () => {
  let sends = 0;
  let clock = 1000;
  const signal = createUserActivitySignal({ send: () => sends++, now: () => clock, debounceMs: 2000 });
  signal();
  assert.equal(sends, 1);
});

test("createUserActivitySignal: debounce 窓内の連打は 1 回に間引く", () => {
  let sends = 0;
  let clock = 1000;
  const signal = createUserActivitySignal({ send: () => sends++, now: () => clock, debounceMs: 2000 });
  signal();            // t=1000 → 送信
  clock = 1500; signal(); // 窓内 → 無視
  clock = 2999; signal(); // 窓内 (1000+2000=3000 未満) → 無視
  assert.equal(sends, 1);
});

test("createUserActivitySignal: 窓を超えたら再送信", () => {
  let sends = 0;
  let clock = 1000;
  const signal = createUserActivitySignal({ send: () => sends++, now: () => clock, debounceMs: 2000 });
  signal();            // t=1000 → 送信 (1)
  clock = 3000; signal(); // t=3000 (>=1000+2000) → 送信 (2)
  clock = 3100; signal(); // 窓内 → 無視
  clock = 5000; signal(); // 窓超え → 送信 (3)
  assert.equal(sends, 3);
});

test("createUserActivitySignal: debounceMs<=0 は毎回送信", () => {
  let sends = 0;
  let clock = 1000;
  const signal = createUserActivitySignal({ send: () => sends++, now: () => clock, debounceMs: 0 });
  signal(); signal(); signal();
  assert.equal(sends, 3);
});
