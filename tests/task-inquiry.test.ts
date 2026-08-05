import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConcordiaClient } from "../src/concordia.js";
import {
  buildTaskInquiryContext,
  reportTaskInquiry,
  type TaskInquirySnapshot,
} from "../src/task-inquiry.js";

const snapshot: TaskInquirySnapshot = {
  activeRepos: ["C:/workspace/Lictor", "C:/workspace/Concordia"],
  branch: "feat/inquiry-and-shutdown",
  hasUncommittedChanges: true,
  recentPr: { number: 213, outcome: "open" },
  task: "#711 Lictor側改修",
};

test("task inquiry context contains only the mechanical completion snapshot", () => {
  assert.equal(
    buildTaskInquiryContext(snapshot),
    [
      "active repos: C:/workspace/Lictor, C:/workspace/Concordia",
      "branch: feat/inquiry-and-shutdown",
      "uncommitted changes: yes",
      "recent PR: #213 (open)",
      "current task: #711 Lictor側改修",
    ].join("\n"),
  );
});

test("reportTaskInquiry uses the fixed タスク category", async () => {
  const payloads: unknown[] = [];
  const client = {
    inquiry: async (payload: unknown) => {
      payloads.push(payload);
    },
  } as unknown as ConcordiaClient;
  await reportTaskInquiry(client, "lictor-test", snapshot);
  assert.deepEqual(payloads, [{
    session_id: "lictor-test",
    category: "タスク",
    context: buildTaskInquiryContext(snapshot),
  }]);
});

test("reportTaskInquiry tolerates an older Concordia without /v1/inquiry", async () => {
  const client = {
    inquiry: async () => {
      throw new Error("404");
    },
  } as unknown as ConcordiaClient;
  await assert.doesNotReject(() => reportTaskInquiry(client, "lictor-test", snapshot));
});
