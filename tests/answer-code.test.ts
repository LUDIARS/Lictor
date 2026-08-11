import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTextAnswerBody, parseOptionCodes } from "../src/answer-code.js";

// @implements SPEC-ASK-MARKER-TEXT-ANSWER
const marker = (multiSelect: boolean) => ({
  question: "which?",
  multiSelect,
  options: [{ label: "first" }, { label: "second" }, { label: "third" }],
});

test("parseOptionCodes: bracketed codes are collected, prose letters are not", () => {
  assert.deepEqual(parseOptionCodes("[A]", 3), [0]);
  assert.deepEqual(parseOptionCodes("[a] でお願いします", 3), [0]);
  assert.deepEqual(parseOptionCodes("[A][C]", 3), [0, 2]);
  assert.deepEqual(parseOptionCodes("[A, C]", 3), [0, 2]);
  assert.deepEqual(parseOptionCodes("A の方針で", 3), []);
  // Out of range codes are ignored rather than clamped to a neighbouring option.
  assert.deepEqual(parseOptionCodes("[D]", 3), []);
});

test("parseOptionCodes: only codes at the very start count", () => {
  // 文頭 (前置きの空白は許容) だけを見る。
  assert.deepEqual(parseOptionCodes("  [B] で", 3), [1]);
  assert.deepEqual(parseOptionCodes("[A] のあと [C] も検討", 3), [0]);
  // 本文の途中に現れたコード (ログ・引用の貼り付け) は回答ではない。
  assert.deepEqual(parseOptionCodes("ログに [B] と出ていた", 3), []);
});

test("buildTextAnswerBody: codes select options, multi only when the card allows it", () => {
  assert.deepEqual(buildTextAnswerBody(7, "[B]", marker(false)), { question_id: 7, answer_index: 1 });
  assert.deepEqual(buildTextAnswerBody(7, "[A][C]", marker(true)), {
    question_id: 7,
    answer_indices: [0, 2],
  });
  // A single-select card takes the first named option, not a multi payload.
  assert.deepEqual(buildTextAnswerBody(7, "[A][C]", marker(false)), { question_id: 7, answer_index: 0 });
});

test("buildTextAnswerBody: a reply without a leading code is not an answer", () => {
  // 無関係な発言 1 通でカードを閉じない — 質問は blocker として残す。
  assert.equal(buildTextAnswerBody(7, "どれでもなく先に調査して", marker(false)), null);
  assert.equal(buildTextAnswerBody(7, "", marker(false)), null);
  assert.equal(buildTextAnswerBody(7, "ログに [B] と出ていた", marker(false)), null);
  // 範囲外のコードだけの返信も回答ではない。
  assert.equal(buildTextAnswerBody(7, "[D]", marker(false)), null);
});

test("buildTextAnswerBody: a leading code answers even when prose follows", () => {
  assert.deepEqual(buildTextAnswerBody(7, "[B] これでお願いします", marker(false)), {
    question_id: 7,
    answer_index: 1,
  });
});
