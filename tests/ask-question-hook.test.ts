import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAskQuestionDenyDecision, readDisabledFlag } from "../src/ask-question-hook.js";

/**
 * Cc spawn では AskUserQuestion の picker を開かせない。picker は Lictor の
 * リレー (Discord 等) 越しには回答できず、開いた時点でセッションが無言で停止する
 * (2026-09-07 の lictor-2a7dc3e9 は 23:58:52 に picker を開いたまま伸びなかった)。
 *
 * 質問そのものは sidecar が Concordia へ流し終えているので、deny しても
 * ユーザに質問が届かなくなることはない。
 */

test("readDisabledFlag: sidecar が disabled を返したら true", () => {
  assert.equal(readDisabledFlag('{"ok":true,"count":1,"ask_user_question_disabled":true}'), true);
});

test("readDisabledFlag: disabled でなければ false", () => {
  assert.equal(readDisabledFlag('{"ok":true,"count":1,"ask_user_question_disabled":false}'), false);
  assert.equal(readDisabledFlag('{"ok":true,"count":1}'), false);
  assert.equal(readDisabledFlag('{"ok":true,"skipped":"no concordia"}'), false);
});

test("readDisabledFlag: 壊れた応答は picker を止めない (fail-open)", () => {
  // sidecar 不達 / 旧版 sidecar でセッションを固めないこと。
  assert.equal(readDisabledFlag(""), false);
  assert.equal(readDisabledFlag("not json"), false);
  assert.equal(readDisabledFlag("null"), false);
  assert.equal(readDisabledFlag("[]"), false);
  assert.equal(readDisabledFlag('{"ask_user_question_disabled":"true"}'), false);
});

test("buildAskQuestionDenyDecision: PreToolUse の deny 決定を返す", () => {
  const decision = JSON.parse(buildAskQuestionDenyDecision()) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
});

test("buildAskQuestionDenyDecision: 聞き直しを防ぐ文面を含む", () => {
  // 単に拒むとモデルは ask マーカーで同じことを聞き直し、質問カードが 2 枚出る。
  const reason = (
    JSON.parse(buildAskQuestionDenyDecision()) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    }
  ).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /送信済み/);
  assert.match(reason, /聞き直さないでください/);
  assert.match(reason, /ターンを終えて待って/);
});
