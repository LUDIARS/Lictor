import { test } from "node:test";
import assert from "node:assert/strict";
import { lineToFrame } from "../src/transcript-tail.js";

test("lineToFrame: assistant text → text frame", () => {
  const f = lineToFrame(JSON.stringify({
    type: "assistant",
    uuid: "msg-1",
    message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "hello world", claude_uuid: "msg-1" } });
});

test("lineToFrame: user text → text frame", () => {
  const f = lineToFrame(JSON.stringify({
    type: "user",
    uuid: "msg-2",
    message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "do the thing", claude_uuid: "msg-2" } });
});

test("lineToFrame: text frame includes null claude_uuid when missing", () => {
  const f = lineToFrame(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "no-uuid" }] },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "no-uuid", claude_uuid: null } });
});

test("lineToFrame: tool_use → tool-use frame with input preview", () => {
  const f = lineToFrame(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls", description: "list" } }] },
  }));
  assert.equal(f?.kind, "tool-use");
  const payload = f?.payload as { name: string; input_preview: string };
  assert.equal(payload.name, "Bash");
  assert.match(payload.input_preview, /"command":"ls"/);
});

test("lineToFrame: tool_result with is_error preserved", () => {
  const f = lineToFrame(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "abc123", is_error: true, content: "failed" }] },
  }));
  assert.equal(f?.kind, "tool-result");
  const payload = f?.payload as { tool_use_id: string; is_error: boolean; preview: string };
  assert.equal(payload.tool_use_id, "abc123");
  assert.equal(payload.is_error, true);
  assert.equal(payload.preview, "failed");
});

test("lineToFrame: thinking → thinking frame (preview capped at 400)", () => {
  const long = "x".repeat(1000);
  const f = lineToFrame(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: long }] },
  }));
  assert.equal(f?.kind, "thinking");
  const payload = f?.payload as { preview: string };
  assert.equal(payload.preview.length, 400);
});

test("lineToFrame: summary → summary frame", () => {
  const f = lineToFrame(JSON.stringify({ type: "summary", summary: "a quick recap" }));
  assert.deepEqual(f, { kind: "summary", payload: { text: "a quick recap" } });
});

test("lineToFrame: unknown type → raw frame", () => {
  const f = lineToFrame(JSON.stringify({ type: "weirdo", weird: "stuff" }));
  assert.equal(f?.kind, "raw");
  const payload = f?.payload as { type: string; keys: string[] };
  assert.equal(payload.type, "weirdo");
  assert.deepEqual(payload.keys.sort(), ["type", "weird"]);
});

test("lineToFrame: malformed JSON returns null", () => {
  assert.equal(lineToFrame("not-json"), null);
  assert.equal(lineToFrame(""), null);
});

test("lineToFrame: non-object JSON returns null", () => {
  assert.equal(lineToFrame("42"), null);
  assert.equal(lineToFrame("null"), null);
});

// ─── Codex CLI 形式 (rollout-*.jsonl) ──────────────────────────────────
//
// Codex は `{timestamp, type, payload}` の三段構成で、 user 発言は
// event_msg.user_message / response_item.message+role=user の両方に出る.
// 重複は許容して両方流す方針.

test("lineToFrame: codex event_msg.user_message → text frame (user)", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:35.329Z",
    type: "event_msg",
    payload: { type: "user_message", message: "こんにちは", images: [] },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "こんにちは" } });
});

test("lineToFrame: codex event_msg.agent_message → text frame (assistant)", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:40.325Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "了解しました", phase: "commentary" },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "了解しました" } });
});

test("lineToFrame: codex response_item.message(role=user,input_text) → text frame", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:35.329Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "ユーザの入力" }],
    },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "ユーザの入力" } });
});

test("lineToFrame: codex response_item.message(role=assistant,output_text) → text frame", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:40.325Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "AIの出力" }],
      phase: "commentary",
    },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "AIの出力" } });
});

test("lineToFrame: codex response_item.reasoning → thinking frame", () => {
  const f = lineToFrame(JSON.stringify({
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: [],
      content: null,
      encrypted_content: "gAAAA...",
    },
  }));
  assert.equal(f?.kind, "thinking");
  const p = f?.payload as { role: string; preview: string };
  assert.equal(p.role, "assistant");
  assert.equal(p.preview, "(encrypted)");
});

test("lineToFrame: codex response_item.reasoning with summary preview", () => {
  const f = lineToFrame(JSON.stringify({
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: ["仕様を確認した", { text: "次にビルドを試す" }],
    },
  }));
  assert.equal(f?.kind, "thinking");
  const p = f?.payload as { preview: string };
  assert.equal(p.preview, "仕様を確認した 次にビルドを試す");
});

test("lineToFrame: codex response_item.message with developer role falls through to raw", () => {
  // role=developer/system は user/assistant ではないので text 化せず raw に落とす.
  const f = lineToFrame(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "<permissions instructions>..." }],
    },
  }));
  assert.equal(f?.kind, "raw");
});

test("lineToFrame: codex session_meta is raw", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:34.646Z",
    type: "session_meta",
    payload: { id: "019e663d-...", cwd: "E:\\Document\\Ars" },
  }));
  assert.equal(f?.kind, "raw");
});

test("lineToFrame: codex multi-part content joins with newline", () => {
  const f = lineToFrame(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "first" },
        { type: "input_text", text: "second" },
      ],
    },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "first\nsecond" } });
});
