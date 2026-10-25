import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionCollaboration } from "../src/session-collaboration.js";
import { CollaborationError, type CollaborationRun, type CollaborationTransport } from "../src/collaboration-transport.js";

function fixture(own = "parent", ownRun: string | null = null) {
  const run: CollaborationRun = { id: "run", parent_session_id: "parent", child_session_id: "child", status: "running", call_name: "work" };
  const notices: string[] = [];
  const sends: Array<{ path: string; body: unknown }> = [];
  const transport: CollaborationTransport = {
    list: async () => ({ runs: own === "parent" ? [{ ...run }] : [], limit: 500 }),
    run: async () => ({ ...run }),
    observe: async peer => ({ status: "active", messages: [{ id: 1, session_id: peer,
      author_type: "assistant", content: "Recovered progress" }] }),
    send: async (path, body) => { sends.push({ path, body }); return { ok: true }; },
  };
  const owner = new SessionCollaboration(own, ownRun, transport, text => notices.push(text));
  const hello = (): void => owner.onEvent({ type: "hello", session_id: own, registered: true });
  return { run, notices, sends, transport, owner, hello };
}

async function settled(owner: SessionCollaboration): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (owner.snapshot().synchronized || owner.snapshot().error) return;
  }
  assert.fail("collaboration did not settle");
}

test("hello restores links and progress; readiness defers notification; duplicate hello does not resend", async () => {
  const f = fixture(); f.hello(); await settled(f.owner);
  assert.equal(f.owner.snapshot().links[0].peer?.progress, "Recovered progress");
  assert.equal(f.notices.length, 0);
  f.owner.setReady(); assert.equal(f.notices.length, 1);
  f.hello(); await settled(f.owner);
  assert.equal(f.notices.length, 1); assert.equal(f.sends.length, 0);
  f.owner.dispose();
});

test("only linked peers contribute progress and questions; no question prompt echo", async () => {
  const f = fixture(); f.owner.setReady(); f.hello(); await settled(f.owner);
  const count = f.notices.length;
  f.owner.onEvent({ type: "question.posted", target_session_id: "stranger", question_id: 8 });
  assert.equal(f.owner.snapshot().links[0].peer?.question_id, null);
  f.owner.onEvent({ type: "question.posted", target_session_id: "child", question_id: 9 });
  assert.equal(f.owner.snapshot().links[0].peer?.question_id, 9);
  assert.equal(f.notices.length, count);
  f.owner.onEvent({ type: "question.answered", target_session_id: "child", question_id: 8 });
  assert.equal(f.owner.snapshot().links[0].peer?.question_id, 9);
  f.owner.onEvent({ type: "question.resolved", target_session_id: "child", question_id: 9 });
  assert.equal(f.owner.snapshot().links[0].peer?.question_id, null);
  f.owner.dispose();
});

test("lost peer alerts once and never completes the delegation", async () => {
  const f = fixture(); f.owner.setReady(); f.hello(); await settled(f.owner);
  const count = f.notices.length;
  f.owner.onEvent({ type: "session.lost", session_id: "child", ts: 10 });
  f.owner.onEvent({ type: "session.lost", session_id: "child", ts: 11 });
  assert.equal(f.notices.length, count + 1);
  assert.equal(f.owner.snapshot().links[0].status, "running"); f.owner.dispose();
});

test("mutations revalidate the run and do not trust a stale child binding", async () => {
  const f = fixture(); f.hello(); await settled(f.owner);
  f.run.child_session_id = "replacement";
  await f.owner.answer("run", 5, "answer");
  assert.match(f.sends[0].path, /replacement\/answer-question$/);
  f.run.parent_session_id = "another-parent";
  await assert.rejects(f.owner.message("run", "instruction"), /unrelated/);
  assert.equal(f.sends.length, 1); f.owner.dispose();
});

test("child can address parent but cannot answer another session's question", async () => {
  const f = fixture("child", "run"); f.hello(); await settled(f.owner);
  await f.owner.message("run", "Need clarification");
  assert.equal(f.sends[0].path, "/v1/sessions/parent/inject");
  await assert.rejects(f.owner.answer("run", 2, "answer"), /not_parent/);
  assert.equal(f.sends.length, 1); f.owner.dispose();
});

test("terminal runs reject mutation; unknown send outcomes are not retried", async () => {
  const f = fixture(); f.run.status = "completed";
  await assert.rejects(f.owner.message("run", "continue"), /not_active/);
  f.run.status = "spawned";
  let attempts = 0;
  f.transport.send = async () => { attempts++; throw new CollaborationError(502, "outcome_unknown"); };
  await assert.rejects(f.owner.message("run", "hello"), /outcome_unknown/);
  assert.equal(attempts, 1); f.owner.dispose();
});

test("disconnect marks the view stale; reconnect reads again; shutdown prevents late notifications", async () => {
  const f = fixture(); f.owner.setReady(); f.hello(); await settled(f.owner);
  f.owner.disconnected(); assert.equal(f.owner.snapshot().synchronized, false);
  f.run.child_session_id = "replacement"; f.hello(); await settled(f.owner);
  assert.equal(f.owner.snapshot().links[0].child_session_id, "replacement");
  const count = f.notices.length; f.owner.dispose(); f.hello();
  f.owner.onEvent({ type: "session.lost", session_id: "replacement" });
  await assert.rejects(f.owner.message("run", "hello"), /closed/);
  assert.equal(f.notices.length, count);
});

test("read failure is visible and reconnect recovers without mutation", async () => {
  const f = fixture(); const list = f.transport.list;
  f.transport.list = async () => { throw new Error("unavailable"); };
  f.hello(); await settled(f.owner);
  assert.equal(f.owner.snapshot().error, "collaboration_sync_failed");
  f.transport.list = list; f.hello(); await settled(f.owner);
  assert.equal(f.owner.snapshot().synchronized, true); assert.equal(f.sends.length, 0);
  f.owner.dispose();
});

test("late read completion after disposal cannot recreate links or notify", async () => {
  const f = fixture();
  let resolve!: (value: { runs: CollaborationRun[]; limit: number }) => void;
  f.transport.list = () => new Promise(done => { resolve = done; });
  f.owner.setReady(); f.hello(); f.owner.dispose();
  resolve({ runs: [f.run], limit: 500 });
  await new Promise<void>(done => setImmediate(done));
  assert.equal(f.owner.snapshot().links.length, 0);
  assert.equal(f.notices.length, 0);
});

test("list cap is visible and cannot be reported as synchronized", async () => {
  const f = fixture(); f.transport.list = async () => ({ runs: [f.run], limit: 1 });
  f.hello(); await new Promise<void>(done => setImmediate(done));
  assert.equal(f.owner.snapshot().truncated, true);
  assert.equal(f.owner.snapshot().synchronized, false); f.owner.dispose();
});
