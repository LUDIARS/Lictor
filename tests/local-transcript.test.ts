import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  transcriptPath,
  appendMessage,
  appendCompaction,
  loadLiveMessages,
} from "../src/local-agent/transcript.js";

test("append then load restores messages in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-tx-"));
  try {
    const p = transcriptPath(dir, "sess1");
    appendMessage(p, "user", "hello");
    appendMessage(p, "assistant", "hi!");
    appendMessage(p, "user", "how are you");
    const live = loadLiveMessages(p);
    assert.deepEqual(
      live.map((m) => [m.role, m.content]),
      [
        ["user", "hello"],
        ["assistant", "hi!"],
        ["user", "how are you"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLiveMessages restores from last compaction (summary + post msgs only)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-tx-"));
  try {
    const p = transcriptPath(dir, "sess2");
    appendMessage(p, "user", "old1");
    appendMessage(p, "assistant", "old2");
    appendCompaction(p, "要約テキスト", 2);
    appendMessage(p, "user", "new1");
    appendMessage(p, "assistant", "new2");
    const live = loadLiveMessages(p);
    assert.equal(live.length, 3);
    assert.equal(live[0].role, "system");
    assert.match(live[0].content, /これまでの会話の要約:\n要約テキスト/);
    assert.deepEqual(
      live.slice(1).map((m) => [m.role, m.content]),
      [
        ["user", "new1"],
        ["assistant", "new2"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLiveMessages returns empty for missing file", () => {
  assert.deepEqual(loadLiveMessages(join(tmpdir(), "does-not-exist-xyz.jsonl")), []);
});
