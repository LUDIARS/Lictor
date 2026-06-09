import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  shouldCompact,
  compact,
  type CompactionConfig,
} from "../src/local-agent/compaction.js";
import type { ChatMessage } from "../src/local-agent/ollama.js";

const CFG: CompactionConfig = { contextTokens: 100, compactRatio: 0.5, keepRecent: 2 };

test("estimateTokens is monotonic in content length", () => {
  const a = estimateTokens([{ role: "user", content: "hi" }]);
  const b = estimateTokens([{ role: "user", content: "hi there, this is much longer" }]);
  assert.ok(b > a);
});

test("shouldCompact triggers over threshold", () => {
  const small: ChatMessage[] = [{ role: "user", content: "x" }];
  assert.equal(shouldCompact(small, CFG), false);
  const big: ChatMessage[] = [{ role: "user", content: "あ".repeat(200) }]; // CJK ~200 tokens > 50
  assert.equal(shouldCompact(big, CFG), true);
});

test("compact folds old turns into one summary, keeps head + recent", async () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "persona" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  ];
  const r = await compact(messages, CFG, async () => "SUM");
  // head(persona) + summary + last keepRecent(2)
  assert.equal(r.messages.length, 4);
  assert.equal(r.messages[0].content, "persona");
  assert.match(r.messages[1].content, /これまでの会話の要約:\nSUM/);
  assert.equal(r.messages[2].content, "u3");
  assert.equal(r.messages[3].content, "a3");
  // body 6 - keepRecent 2 = 4 dropped
  assert.equal(r.dropped, 4);
});

test("compact is no-op when body <= keepRecent", async () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "persona" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ];
  const r = await compact(messages, CFG, async () => "SUM");
  assert.equal(r.dropped, 0);
  assert.equal(r.messages, messages);
});

test("compact falls back to placeholder when summarizer throws", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
  ];
  const r = await compact(messages, CFG, async () => {
    throw new Error("LLM down");
  });
  assert.ok(r.dropped > 0);
  assert.match(r.messages[0].content, /省略されました/);
});
