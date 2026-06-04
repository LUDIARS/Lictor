import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAnsweredQuestionIds,
  detectAskUserQuestion,
  extractPendingQuestions,
  providerSupportsAskUserQuestion,
} from "../src/ask-question-relay.js";
import { PROVIDERS } from "../src/provider.js";

test("extractPendingQuestions: PreToolUse の tool_input.questions[] を変換 (早期投稿用)", () => {
  const questions = [
    {
      question: "進めますか?",
      options: [
        { label: "はい", description: "進める" },
        "いいえ",
      ],
    },
    { question: "  ", options: [{ label: "x" }] }, // 空 question → skip
    { question: "options 無し", options: [] }, // option ゼロ → skip
  ];
  const pqs = extractPendingQuestions(questions);
  assert.equal(pqs.length, 1);
  assert.equal(pqs[0].id, ""); // PreToolUse は tool_use id を持たない
  assert.equal(pqs[0].question, "進めますか?");
  assert.deepEqual(pqs[0].options, [{ label: "はい", description: "進める" }, { label: "いいえ" }]);
});

test("extractPendingQuestions: 非配列は空", () => {
  assert.deepEqual(extractPendingQuestions(undefined), []);
  assert.deepEqual(extractPendingQuestions("nope"), []);
  assert.deepEqual(extractPendingQuestions(null), []);
});

test("detectAskUserQuestion: AskUserQuestion tool_use → 単一 question 配列", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which option?",
                header: "Pick",
                options: [
                  { label: "Yes", description: "Do it" },
                  { label: "No", description: "Skip" },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ],
    },
  });
  const pqs = detectAskUserQuestion(line);
  assert.equal(pqs.length, 1);
  assert.equal(pqs[0].question, "Which option?");
  assert.deepEqual(pqs[0].options, [
    { label: "Yes", description: "Do it" },
    { label: "No", description: "Skip" },
  ]);
});

test("detectAskUserQuestion: 非 AskUserQuestion tool_use は空配列", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  });
  assert.deepEqual(detectAskUserQuestion(line), []);
});

test("detectAskUserQuestion: text frame は空配列", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  });
  assert.deepEqual(detectAskUserQuestion(line), []);
});

test("detectAskUserQuestion: user message は空配列", () => {
  const line = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(detectAskUserQuestion(line), []);
});

test("detectAskUserQuestion: 複数 questions[] は全部返す", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "AskUserQuestion",
          input: {
            questions: [
              { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
              { question: "Q2", options: [{ label: "C" }, { label: "D" }] },
            ],
          },
        },
      ],
    },
  });
  const pqs = detectAskUserQuestion(line);
  assert.equal(pqs.length, 2);
  assert.equal(pqs[0].question, "Q1");
  assert.deepEqual(pqs[0].options, [{ label: "A" }, { label: "B" }]);
  assert.equal(pqs[1].question, "Q2");
  assert.deepEqual(pqs[1].options, [{ label: "C" }, { label: "D" }]);
});

test("detectAskUserQuestion: options の string 直挿しを受け入れる", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "AskUserQuestion",
          input: {
            questions: [{ question: "Pick", options: ["alpha", "beta", "gamma"] }],
          },
        },
      ],
    },
  });
  const pqs = detectAskUserQuestion(line);
  assert.equal(pqs.length, 1);
  assert.deepEqual(pqs[0].options, [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }]);
});

test("detectAskUserQuestion: 空 options / 空 question は除外 (両方空なら空配列)", () => {
  const emptyOpts = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "Q", options: [] }] } }] },
  });
  assert.deepEqual(detectAskUserQuestion(emptyOpts), []);

  const emptyQ = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "", options: [{ label: "A" }] }] } }] },
  });
  assert.deepEqual(detectAskUserQuestion(emptyQ), []);
});

test("detectAskUserQuestion: 有効 + 無効 が混在しても 有効分だけ拾う", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "AskUserQuestion",
          input: {
            questions: [
              { question: "OK", options: [{ label: "x" }] },
              { question: "", options: [{ label: "y" }] },
              { question: "OK2", options: [] },
              { question: "OK3", options: [{ label: "z" }] },
            ],
          },
        },
      ],
    },
  });
  const pqs = detectAskUserQuestion(line);
  assert.equal(pqs.length, 2);
  assert.equal(pqs[0].question, "OK");
  assert.equal(pqs[1].question, "OK3");
});

test("detectAskUserQuestion: malformed JSON は空配列", () => {
  assert.deepEqual(detectAskUserQuestion("not-json"), []);
  assert.deepEqual(detectAskUserQuestion(""), []);
  assert.deepEqual(detectAskUserQuestion("42"), []);
});

test("detectAskUserQuestion: tool_use id を PendingQuestion.id に載せる", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_abc123",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }] },
        },
      ],
    },
  });
  const pqs = detectAskUserQuestion(line);
  assert.equal(pqs.length, 1);
  assert.equal(pqs[0].id, "toolu_abc123");
});

test("detectAskUserQuestion: 複数 questions[] は同一 tool_use id を共有", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_xyz",
          name: "AskUserQuestion",
          input: {
            questions: [
              { question: "Q1", options: [{ label: "A" }] },
              { question: "Q2", options: [{ label: "B" }] },
            ],
          },
        },
      ],
    },
  });
  const pqs = detectAskUserQuestion(line);
  assert.deepEqual(pqs.map((p) => p.id), ["toolu_xyz", "toolu_xyz"]);
});

test("detectAnsweredQuestionIds: user tool_result の tool_use_id を返す", () => {
  // 実データ準拠: AskUserQuestion の回答は直後の user 行に
  // tool_result{tool_use_id} として現れる。
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_abc123",
          content: 'Your questions have been answered: "Q"="A"',
        },
      ],
    },
  });
  assert.deepEqual(detectAnsweredQuestionIds(line), ["toolu_abc123"]);
});

test("detectAnsweredQuestionIds: assistant 行 / 非 tool_result は空配列", () => {
  const assistantLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }] },
  });
  assert.deepEqual(detectAnsweredQuestionIds(assistantLine), []);
  const noResult = JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: "plain message" }] },
  });
  assert.deepEqual(detectAnsweredQuestionIds(noResult), []);
  assert.deepEqual(detectAnsweredQuestionIds("not-json"), []);
});

test("providerSupportsAskUserQuestion: claude のみ true", () => {
  assert.equal(providerSupportsAskUserQuestion(PROVIDERS.claude), true);
  assert.equal(providerSupportsAskUserQuestion(PROVIDERS.codex), false);
  assert.equal(providerSupportsAskUserQuestion(PROVIDERS.gemini), false);
});
