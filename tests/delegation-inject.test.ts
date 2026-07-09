import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDelegationInjector,
  delegationInjectDelayMs,
  delegationPromptPath,
  delegationSessionMetadata,
  DELEGATION_PROMPT_ENV,
  DELEGATION_RUN_ID_ENV,
  DELEGATION_CALL_NAME_ENV,
  DELEGATION_PARENT_SESSION_ENV,
  loadDelegationPrompt,
  sanitizeDelegationPrompt,
} from "../src/delegation-inject.js";

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
