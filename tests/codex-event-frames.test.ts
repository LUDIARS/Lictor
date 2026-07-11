import test from "node:test";
import assert from "node:assert/strict";
import { CodexEventFrameMapper, parseTurnCompletion } from "../src/codex-event-frames.js";

test("CodexEventFrameMapper maps completed messages once", () => {
  const mapper = new CodexEventFrameMapper("thread-a");
  const notification = {
    method: "item/completed",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      item: { id: "item-a", type: "agentMessage", text: "done", phase: "final_answer" },
    },
  };
  assert.deepEqual(mapper.map(notification), {
    dedupKey: "thread-a:turn-a:item-a:completed",
    kind: "text",
    payload: {
      role: "assistant",
      text: "done",
      phase: "final_answer",
      item_id: "item-a",
      turn_id: "turn-a",
    },
  });
  assert.equal(mapper.map(notification), null);
});

test("CodexEventFrameMapper rejects another thread and strips file diffs", () => {
  const mapper = new CodexEventFrameMapper("thread-a");
  assert.equal(mapper.map({
    method: "item/completed",
    params: {
      threadId: "thread-b",
      turnId: "turn-b",
      item: { id: "item-b", type: "agentMessage", text: "secret" },
    },
  }), null);
  const frame = mapper.map({
    method: "item/completed",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      item: {
        id: "item-c",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/a.ts", kind: "update", diff: "sensitive body" }],
      },
    },
  });
  assert.deepEqual(frame?.payload, {
    type: "file_change",
    item_id: "item-c",
    turn_id: "turn-a",
    status: "completed",
    changes: [{ path: "src/a.ts", kind: "update" }],
  });
});

test("parseTurnCompletion returns only the expected thread", () => {
  const event = {
    method: "turn/completed",
    params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } },
  };
  assert.deepEqual(parseTurnCompletion(event, "thread-a"), {
    threadId: "thread-a",
    turnId: "turn-a",
    status: "completed",
    errorMessage: null,
  });
  assert.equal(parseTurnCompletion(event, "thread-b"), null);
});
