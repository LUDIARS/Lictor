import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAskUserQuestion,
  providerSupportsAskUserQuestion,
} from "../src/ask-question-relay.js";
import { PROVIDERS } from "../src/provider.js";

test("detectAskUserQuestion: AskUserQuestion tool_use → question + options", () => {
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
  const pq = detectAskUserQuestion(line);
  assert.ok(pq);
  assert.equal(pq.question, "Which option?");
  assert.deepEqual(pq.options, [
    { label: "Yes", description: "Do it" },
    { label: "No", description: "Skip" },
  ]);
});

test("detectAskUserQuestion: 非 AskUserQuestion tool_use は null", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  });
  assert.equal(detectAskUserQuestion(line), null);
});

test("detectAskUserQuestion: text frame は null", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  });
  assert.equal(detectAskUserQuestion(line), null);
});

test("detectAskUserQuestion: user message は null", () => {
  const line = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } });
  assert.equal(detectAskUserQuestion(line), null);
});

test("detectAskUserQuestion: 複数 questions[] は先頭だけ", () => {
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
  const pq = detectAskUserQuestion(line);
  assert.ok(pq);
  assert.equal(pq.question, "Q1");
  assert.deepEqual(pq.options, [{ label: "A" }, { label: "B" }]);
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
  const pq = detectAskUserQuestion(line);
  assert.deepEqual(pq?.options, [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }]);
});

test("detectAskUserQuestion: 空 options / 空 question は null", () => {
  const emptyOpts = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "Q", options: [] }] } }] },
  });
  assert.equal(detectAskUserQuestion(emptyOpts), null);

  const emptyQ = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "", options: [{ label: "A" }] }] } }] },
  });
  assert.equal(detectAskUserQuestion(emptyQ), null);
});

test("detectAskUserQuestion: malformed JSON は null", () => {
  assert.equal(detectAskUserQuestion("not-json"), null);
  assert.equal(detectAskUserQuestion(""), null);
  assert.equal(detectAskUserQuestion("42"), null);
});

test("providerSupportsAskUserQuestion: claude のみ true", () => {
  assert.equal(providerSupportsAskUserQuestion(PROVIDERS.claude), true);
  assert.equal(providerSupportsAskUserQuestion(PROVIDERS.codex), false);
  assert.equal(providerSupportsAskUserQuestion(PROVIDERS.gemini), false);
});
