import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDelegationInjector,
  delegationInjectDelayMs,
  delegationInjectMaxAttempts,
  delegationInjectVerifyMs,
  delegationPromptPath,
  delegationSessionMetadata,
  DELEGATION_PROMPT_ENV,
  DELEGATION_RUN_ID_ENV,
  DELEGATION_CALL_NAME_ENV,
  DELEGATION_PARENT_SESSION_ENV,
  loadDelegationPrompt,
  sanitizeDelegationPrompt,
} from "../src/delegation-inject.js";

// @implements SPEC-DELEGATION-LEGACY-RETRY

test("delegationSessionMetadata: maps delegation env → metadata keys, trims, drops empty", () => {
  assert.deepEqual(delegationSessionMetadata({}), {});
  assert.deepEqual(
    delegationSessionMetadata({
      [DELEGATION_RUN_ID_ENV]: "  run-1  ",
      [DELEGATION_CALL_NAME_ENV]: "impl-from-design",
      [DELEGATION_PARENT_SESSION_ENV]: "lictor-parent",
    }),
    {
      delegation_run_id: "run-1",
      delegation_call_name: "impl-from-design",
      delegation_parent_session_id: "lictor-parent",
    },
  );
  // run_id だけでも紐付けに十分。空白のみのキーは落とす。
  assert.deepEqual(
    delegationSessionMetadata({ [DELEGATION_RUN_ID_ENV]: "run-2", [DELEGATION_CALL_NAME_ENV]: "   " }),
    { delegation_run_id: "run-2" },
  );
});

test("delegationPromptPath reads env, trims, null when empty", () => {
  assert.equal(delegationPromptPath({ [DELEGATION_PROMPT_ENV]: "  /tmp/p.md  " }), "/tmp/p.md");
  assert.equal(delegationPromptPath({ [DELEGATION_PROMPT_ENV]: "   " }), null);
  assert.equal(delegationPromptPath({}), null);
});

test("delegationInjectDelayMs: default + override + invalid fallback", () => {
  assert.equal(delegationInjectDelayMs({}), 2500);
  assert.equal(delegationInjectDelayMs({ LICTOR_DELEGATION_INJECT_DELAY_MS: "0" }), 0);
  assert.equal(delegationInjectDelayMs({ LICTOR_DELEGATION_INJECT_DELAY_MS: "800" }), 800);
  assert.equal(delegationInjectDelayMs({ LICTOR_DELEGATION_INJECT_DELAY_MS: "-5" }), 2500);
  assert.equal(delegationInjectDelayMs({ LICTOR_DELEGATION_INJECT_DELAY_MS: "x" }), 2500);
});

test("sanitizeDelegationPrompt: CRLF→LF, strips C0/ESC, keeps tab, trims tail", () => {
  const out = sanitizeDelegationPrompt("line1\r\nline2\x1b[31m\tred\x00\nlast   \n\n");
  assert.equal(out, "line1\nline2\tred\nlast");
  // 内部の改行は保持 (複数行 prompt)
  assert.ok(out.includes("\n"));
  // ESC / NUL は除去
  assert.ok(!out.includes("\x1b"));
  assert.ok(!out.includes("\x00"));
});

test("loadDelegationPrompt: null when env missing; reads+sanitizes when present", () => {
  assert.equal(loadDelegationPrompt({}, () => "x"), null);
  const loaded = loadDelegationPrompt(
    { [DELEGATION_PROMPT_ENV]: "/tmp/p.md" },
    () => "hello\r\nworld\n",
  );
  assert.deepEqual(loaded, { path: "/tmp/p.md", text: "hello\nworld" });
});

test("loadDelegationPrompt: null when file read throws or content empty", () => {
  assert.equal(
    loadDelegationPrompt({ [DELEGATION_PROMPT_ENV]: "/missing" }, () => {
      throw new Error("ENOENT");
    }),
    null,
  );
  assert.equal(loadDelegationPrompt({ [DELEGATION_PROMPT_ENV]: "/tmp/p.md" }, () => "  \n "), null);
});

test("createDelegationInjector: submits exactly once after first notifyData", () => {
  const submitted: string[] = [];
  const timers: Array<() => void> = [];
  const inj = createDelegationInjector({
    prompt: { path: "/tmp/p.md", text: "do the thing" },
    submit: (t) => submitted.push(t),
    delayMs: 100,
    setTimeoutFn: (cb) => { timers.push(cb); },
  });

  assert.equal(inj.injected(), false);
  inj.notifyData();
  inj.notifyData(); // 2 回目以降は arm 済みで no-op
  assert.equal(timers.length, 1, "timer armed once");

  timers[0]!(); // 遅延発火
  assert.deepEqual(submitted, ["do the thing"]);
  assert.equal(inj.injected(), true);

  // 発火後の notifyData も再 submit しない
  inj.notifyData();
  assert.equal(timers.length, 1);
  assert.deepEqual(submitted, ["do the thing"]);
});

test("delegationInjectVerifyMs / MaxAttempts: env override with a safe fallback", () => {
  assert.equal(delegationInjectVerifyMs({}), 45_000);
  assert.equal(delegationInjectVerifyMs({ LICTOR_DELEGATION_INJECT_VERIFY_MS: "1000" }), 1000);
  assert.equal(delegationInjectVerifyMs({ LICTOR_DELEGATION_INJECT_VERIFY_MS: "0" }), 0);
  assert.equal(delegationInjectVerifyMs({ LICTOR_DELEGATION_INJECT_VERIFY_MS: "nope" }), 45_000);
  assert.equal(delegationInjectVerifyMs({ LICTOR_DELEGATION_INJECT_VERIFY_MS: "" }), 45_000);
  assert.equal(delegationInjectVerifyMs({ LICTOR_DELEGATION_INJECT_VERIFY_MS: "2147483648" }), 45_000);
  assert.equal(delegationInjectMaxAttempts({}), 3);
  assert.equal(delegationInjectMaxAttempts({ LICTOR_DELEGATION_INJECT_MAX_ATTEMPTS: "5" }), 5);
  // 0 回では 1 度も送れない。 不正値は既定へ倒す。
  assert.equal(delegationInjectMaxAttempts({ LICTOR_DELEGATION_INJECT_MAX_ATTEMPTS: "0" }), 3);
  assert.equal(delegationInjectMaxAttempts({ LICTOR_DELEGATION_INJECT_MAX_ATTEMPTS: "11" }), 3);
});

test("createDelegationInjector: re-sends the prompt when no user turn is observed", () => {
  const submitted: string[] = [];
  const cleared: string[] = [];
  const timers: Array<() => void> = [];
  const inj = createDelegationInjector({
    prompt: { path: "/tmp/p.md", text: "do the thing" },
    submit: (t) => submitted.push(t),
    clearInput: (d) => cleared.push(d),
    delayMs: 100,
    verifyMs: 1000,
    maxAttempts: 3,
    log: () => { throw new Error("diagnostic sink closed"); },
    setTimeoutFn: (cb) => { timers.push(cb); },
  });

  inj.notifyData();
  timers[0]!(); // 初回 paste
  assert.deepEqual(submitted, ["do the thing"]);
  assert.equal(cleared.length, 0, "first attempt must not clear the input");

  timers[1]!(); // verify 期限 — user フレーム未観測なので再送
  assert.equal(submitted.length, 2);
  assert.deepEqual(cleared, [""], "a re-send clears the input first");

  timers[2]!(); // 2 度目の verify 期限 — 最大試行数に達する
  assert.equal(submitted.length, 3);
  assert.equal(inj.attempts(), 3);
  assert.equal(timers.length, 3, "no verify timer after the final attempt");
});

test("createDelegationInjector: stops re-sending once a user turn is observed", () => {
  const submitted: string[] = [];
  const timers: Array<() => void> = [];
  const inj = createDelegationInjector({
    prompt: { path: "/tmp/p.md", text: "do the thing" },
    submit: (t) => submitted.push(t),
    delayMs: 100,
    verifyMs: 1000,
    maxAttempts: 3,
    setTimeoutFn: (cb) => { timers.push(cb); },
  });

  inj.notifyData();
  timers[0]!();
  inj.noteUserMessage(); // 到達を観測
  timers[1]!(); // verify 期限が来ても再送しない

  assert.deepEqual(submitted, ["do the thing"]);
  assert.equal(inj.accepted(), true);
});

test("createDelegationInjector: ignores user frames observed before the first attempt", () => {
  const submitted: string[] = [];
  const timers: Array<() => void> = [];
  const inj = createDelegationInjector({
    prompt: { path: "/tmp/p.md", text: "do the thing" },
    submit: (t) => submitted.push(t),
    delayMs: 100,
    verifyMs: 1000,
    maxAttempts: 3,
    setTimeoutFn: (cb) => { timers.push(cb); },
  });

  inj.notifyData();
  inj.noteUserMessage();
  assert.equal(inj.accepted(), false);
  timers[0]!();

  assert.deepEqual(submitted, ["do the thing"]);
});

test("createDelegationInjector: invalid direct retry options fall back to one safe attempt", () => {
  const submitted: string[] = [];
  const timers: Array<() => void> = [];
  const inj = createDelegationInjector({
    prompt: { path: "/tmp/p.md", text: "do the thing" },
    submit: (t) => submitted.push(t),
    delayMs: 100,
    verifyMs: 1000,
    maxAttempts: Number.NaN,
    setTimeoutFn: (cb) => { timers.push(cb); },
  });

  inj.notifyData();
  timers[0]!();

  assert.deepEqual(submitted, ["do the thing"]);
  assert.equal(timers.length, 1, "invalid maxAttempts must not create an unbounded retry chain");
});

test("createDelegationInjector: keeps the single-shot behaviour when verification is off", () => {
  const submitted: string[] = [];
  const timers: Array<() => void> = [];
  const inj = createDelegationInjector({
    prompt: { path: "/tmp/p.md", text: "do the thing" },
    submit: (t) => submitted.push(t),
    delayMs: 100,
    verifyMs: 0,
    maxAttempts: 3,
    setTimeoutFn: (cb) => { timers.push(cb); },
  });

  inj.notifyData();
  timers[0]!();
  assert.deepEqual(submitted, ["do the thing"]);
  assert.equal(timers.length, 1, "no verify timer is armed");
});
