import { test } from "node:test";
import assert from "node:assert/strict";
import { startSidecar, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";
import { SessionCollaboration } from "../src/session-collaboration.js";
import type { CollaborationTransport } from "../src/collaboration-transport.js";

async function withSidecar(overrides: Partial<SidecarContext>, use: (base: string) => Promise<void>): Promise<void> {
  const ctx: SidecarContext = {
    meta: gatherBaseMeta(), titleState: { manualOverride: null }, concordia: null,
    sessionId: null, roleLabel: null, injector: null, ptyWriter: null,
    notifyState: { mark: null, expiresAt: null }, conflictState: { count: 0, titleMark: null },
    taskState: { branch: null, desc: null, updatedAt: null },
    activeRepoState: { lastActive: null, lastList: [] }, getClaudeSessionId: null,
    getTranscript: null, repinTranscript: null, forceExit: null, requestGracefulExit: null,
    ...overrides,
  };
  const sidecar = await startSidecar(ctx);
  try { await use(`http://127.0.0.1:${sidecar.port}`); } finally { sidecar.close(); ctx.collaboration?.dispose(); }
}

test("collaboration routes require a registered coordinator", async () => {
  await withSidecar({}, async base => {
    for (const [path, method] of [["", "GET"], ["/message", "POST"], ["/answer", "POST"]]) {
      const response = await fetch(`${base}/v1/collaboration${path}`, { method });
      assert.equal(response.status, 503);
    }
  });
});

test("sidecar rejects caller-supplied session identity and sends sanitized scoped messages", async () => {
  const sends: unknown[] = [];
  const transport: CollaborationTransport = {
    list: async () => ({ runs: [], limit: 500 }),
    run: async id => ({ id, call_name: "work", parent_session_id: "parent", child_session_id: "child", status: "running" }),
    observe: async () => ({ status: "active", messages: [] }),
    send: async (_path, body) => { sends.push(body); return { ok: true }; },
  };
  const collaboration = new SessionCollaboration("parent", null, transport, () => {});
  await withSidecar({ sessionId: "parent", concordia: {} as SidecarContext["concordia"], collaboration }, async base => {
    const post = (path: string, body: unknown) => fetch(`${base}/v1/collaboration/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await post("message", { run_id: "run", text: "hello", session_id: "stranger" })).status, 400);
    assert.equal(sends.length, 0);
    assert.equal((await post("message", { run_id: "run", text: "\u001b[31mhello\u0000" })).status, 200);
    assert.doesNotMatch(JSON.stringify(sends[0]), /001b|0000/);
    assert.equal((await post("answer", { run_id: "run", question_id: 3, answer_index: 0 })).status, 200);
    assert.deepEqual(sends[1], { question_id: 3, answer_index: 0 });
    assert.equal((await post("answer", { run_id: "run", question_id: 3, answer_index: 0, text: "both" })).status, 400);
  });
});
