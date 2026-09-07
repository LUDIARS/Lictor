import { test } from "node:test";
import assert from "node:assert/strict";
import { askUserQuestionDisableArgs, planAskMarkerActivation } from "../src/ask-marker-activation.js";

// @implements SPEC-ASK-MARKER-ACTIVATION

test("planAskMarkerActivation: Codex detection does not require a session injector", () => {
  assert.deepEqual(planAskMarkerActivation("codex", true, false), {
    enabled: true,
    injection: "none",
    reason: "codex-external-steering",
  });
});

test("planAskMarkerActivation: Codex detection requires Concordia", () => {
  assert.deepEqual(planAskMarkerActivation("codex", false, false), {
    enabled: false,
    injection: "none",
    reason: "concordia-disabled",
  });
});

test("planAskMarkerActivation: Claude uses session system-prompt injection", () => {
  assert.deepEqual(planAskMarkerActivation("claude", true, true), {
    enabled: true,
    injection: "claude-system-prompt",
    reason: "claude-system-prompt",
  });
});

test("planAskMarkerActivation: Claude reports a missing session injector", () => {
  assert.deepEqual(planAskMarkerActivation("claude", true, false), {
    enabled: false,
    injection: "none",
    reason: "session-injector-missing",
  });
});

test("planAskMarkerActivation: unsupported providers stay disabled", () => {
  assert.deepEqual(planAskMarkerActivation("gemini", true, false), {
    enabled: false,
    injection: "none",
    reason: "provider-unsupported",
  });
});

// --- Cc spawn では AskUserQuestion をツールごと外す -----------------------
// 2026-09-05 / 2026-09-07: 追記プロンプトの「使わないでください」だけでは
// Claude Code 既定の「迷ったら AskUserQuestion」に負け、リレー越しに押せない
// picker でセッションが無言停止した。

test("askUserQuestionDisableArgs: Cc spawn の claude では picker を外す", () => {
  assert.deepEqual(
    askUserQuestionDisableArgs("claude", "d631f7c5-5d3d-4a5d-9993-53d9f75103c4"),
    ["--disallowedTools", "AskUserQuestion"],
  );
});

test("askUserQuestionDisableArgs: enrollment が無い対話起動では外さない", () => {
  // 人間が端末の前にいるので picker は普通に答えられる。
  assert.deepEqual(askUserQuestionDisableArgs("claude", null), []);
  assert.deepEqual(askUserQuestionDisableArgs("claude", ""), []);
  assert.deepEqual(askUserQuestionDisableArgs("claude", "   "), []);
});

test("askUserQuestionDisableArgs: claude 以外には付けない", () => {
  // codex / gemini に AskUserQuestion 相当のツールは無い。
  assert.deepEqual(askUserQuestionDisableArgs("codex", "spawn-id"), []);
  assert.deepEqual(askUserQuestionDisableArgs("gemini", "spawn-id"), []);
});
