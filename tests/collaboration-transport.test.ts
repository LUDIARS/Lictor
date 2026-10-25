import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollaborationTransport } from "../src/collaboration-transport.js";

test("transport distinguishes unknown mutation outcome from unavailable reads without retry", async () => {
  let calls = 0;
  const transport = createCollaborationTransport("http://coordinator", async () => {
    calls++; throw new Error("private network details");
  });
  const signal = new AbortController().signal;
  await assert.rejects(transport.send("/message", {}, signal), /outcome_unknown_do_not_resend/);
  assert.equal(calls, 1);
  await assert.rejects(transport.run("run", signal), /collaboration_unavailable/);
  assert.equal(calls, 2);
});

test("transport rejects malformed canonical relationships and preserves rejection status", async () => {
  const malformed = createCollaborationTransport("http://coordinator", async () => Response.json({ run: { id: "r" } }));
  await assert.rejects(malformed.run("r", new AbortController().signal), /invalid_collaboration_run/);
  const rejected = createCollaborationTransport("http://coordinator", async () => new Response("private detail", { status: 409 }));
  await assert.rejects(rejected.send("/message", {}, new AbortController().signal),
    error => error instanceof Error && "status" in error && error.status === 409 && !error.message.includes("private"));
});
