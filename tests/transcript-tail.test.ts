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
