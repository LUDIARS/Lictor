import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explicitCodexResumeThreadId, isResumeRelayRecord } from "../src/codex-resume-binding.js";
import { startTranscriptTail } from "../src/transcript-tail.js";
import { PROVIDERS } from "../src/provider.js";

const THREAD = "11111111-2222-4333-8444-555555555555";

test("only an explicit resume UUID supplies launch identity", () => {
  assert.equal(explicitCodexResumeThreadId(["resume", THREAD]), THREAD);
  for (const args of [[], ["resume", "--last"], ["resume", "named-thread"], ["exec", "resume", THREAD]]) {
    assert.equal(explicitCodexResumeThreadId(args), null);
  }
});

test("resume does not replay old or undated records", () => {
  const since = Date.parse("2026-10-12T00:00:00Z");
  assert.equal(isResumeRelayRecord('{"timestamp":"2026-10-11T23:59:59Z"}', since), false);
  assert.equal(isResumeRelayRecord('{}', since), false);
  assert.equal(isResumeRelayRecord('broken', since), false);
  assert.equal(isResumeRelayRecord('{"timestamp":"2026-10-12T00:00:00Z"}', since), true);
});

test("explicit resume binds an old originator but relays only new replies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-resume-"));
  const since = Date.now();
  const old = new Date(since - 86_400_000).toISOString();
  const recent = new Date(since + 1).toISOString();
  const reply = (text: string, timestamp: string) => JSON.stringify({ timestamp,
    type: "event_msg", payload: { type: "agent_message", message: text, phase: "final_answer" } });
  const metadata = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "session_meta",
    payload: { id: THREAD, session_id: THREAD, cwd: dir, source: "cli", timestamp: old,
      originator: "lictor:previous-wrapper", ...extra } });
  const expected = join(dir, `rollout-${THREAD}.jsonl`);
  const frames: Array<{ kind: string; payload: unknown }> = [];
  const variants = [
    { id: "other-thread", session_id: "other-thread" },
    { thread_source: "subagent", source: { subagent: { other: "guardian" } } },
    { cwd: join(dir, "different") },
    { source: "exec" },
  ];
  const tail = startTranscriptTail({ cwd: dir, sessionId: "resume-test-wrapper",
    provider: { ...PROVIDERS.codex, transcriptDir: () => dir },
    concordiaBaseUrl: "http://127.0.0.1:1", expectedCodexOriginator: "lictor:new-wrapper",
    expectedCodexThreadId: THREAD, resumedCodexThreadId: THREAD, resumeRelaySinceMs: since,
    transcriptSink: { post: async (kind, payload) => {
      frames.push({ kind, payload }); return { seq: frames.length, persisted: true };
    }, flush: async () => undefined },
  });
  try {
    variants.forEach((extra, i) => writeFileSync(join(dir, `wrong-${i}.jsonl`),
      metadata(extra) + "\n" + reply("must not relay", recent) + "\n"));
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(tail.getTranscriptPath(), null);
    assert.equal(frames.length, 0);
    writeFileSync(expected, metadata() + "\n" + reply("historical reply", old) + "\n");
    utimesSync(expected, since / 1000 - 86400, since / 1000 - 86400);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(tail.getTranscriptPath(), expected);
    assert.equal(frames.length, 0);
    appendFileSync(expected, reply("resumed reply", recent) + "\n");
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.deepEqual(frames.filter(frame => frame.kind === "text").map(frame =>
      (frame.payload as { text: string }).text), ["resumed reply"]);
  } finally {
    tail.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
