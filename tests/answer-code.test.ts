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

test("buildTextAnswerBody: codes select options, multi only when the card allows it", () => {
  assert.deepEqual(buildTextAnswerBody(7, "[B]", marker(false)), { question_id: 7, answer_index: 1 });
  assert.deepEqual(buildTextAnswerBody(7, "[A][C]", marker(true)), {
    question_id: 7,
    answer_indices: [0, 2],
  });
  // A single-select card takes the first named option, not a multi payload.
  assert.deepEqual(buildTextAnswerBody(7, "[A][C]", marker(false)), { question_id: 7, answer_index: 0 });
});

test("buildTextAnswerBody: an answer outside the options is kept as free text", () => {
  assert.deepEqual(buildTextAnswerBody(7, "どれでもなく先に調査して", marker(false)), {
    question_id: 7,
    other_text: "どれでもなく先に調査して",
  });
  assert.equal(buildTextAnswerBody(7, "", marker(false)), null);
  assert.deepEqual(buildTextAnswerBody(7, "  free text  ", marker(false)), {
    question_id: 7,
    other_text: "  free text  ",
  });
});
