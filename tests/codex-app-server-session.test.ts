import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeCodexAppServerSession,
  CodexDelegationError,
  runCodexDelegationTurn,
  startCodexAppServerSession,
} from "../src/codex-app-server-session.js";
import type { TranscriptFrameSink, TranscriptPostResult } from "../src/transcript-sink.js";

class RecordingSink implements TranscriptFrameSink {
  readonly frames: Array<{ seq: number; kind: string; payload: unknown }> = [];

  async post(kind: string, payload: unknown): Promise<TranscriptPostResult> {
    const seq = this.frames.length;
    this.frames.push({ seq, kind, payload });
    return { seq, persisted: true };
  }

  async flush(): Promise<void> {}
}

function createProtocolChild(options: { mismatch?: boolean } = {}): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = "";
  let exited = false;
  const send = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  stdin.on("data", (chunk) => {
    input += String(chunk);
    const lines = input.split("\n");
    input = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as { id?: number; method?: string };
      if (request.id === undefined) continue;
      switch (request.method) {
        case "initialize":
          send({ id: request.id, result: {} });
          break;
        case "account/read":
          send({
            id: request.id,
            result: {
              account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
              requiresOpenaiAuth: true,
            },
          });
          break;
        case "thread/start":
          send({ method: "thread/started", params: { thread: { id: "thread-a" } } });
          send({
            id: request.id,
            result: { thread: { id: "thread-a", sessionId: "session-a" } },
          });
          break;
        case "turn/start":
          send({ id: request.id, result: { turn: { id: "turn-a", status: "inProgress" } } });
          queueMicrotask(() => {
            const threadId = options.mismatch ? "thread-b" : "thread-a";
            send({
              method: "item/completed",
              params: {
                threadId,
                turnId: "turn-a",
                item: {
                  id: "user-a",
                  type: "userMessage",
                  content: [{ type: "text", text: "implement it" }],
                },
              },
            });
            if (options.mismatch) return;
            send({
              method: "item/completed",
              params: {
                threadId: "thread-a",
                turnId: "turn-a",
                item: { id: "agent-a", type: "agentMessage", text: "done", phase: "final_answer" },
              },
            });
            send({
              method: "turn/completed",
              params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } },
            });
          });
          break;
      }
    }
  });
  const emitExit = () => {
    if (exited) return;
    exited = true;
    emitter.emit("exit", 0, null);
  };
  stdin.on("finish", () => queueMicrotask(emitExit));
  Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      queueMicrotask(emitExit);
      return true;
    },
  });
  return emitter as ChildProcessWithoutNullStreams;
}

test("App Server session persists binding before delegation frames", async () => {
  const sink = new RecordingSink();
  const session = await startCodexAppServerSession({
    binary: "codex",
    cwd: "C:\\repo",
    env: {},
    sink,
    lictorVersion: "test",
    spawnProcess: () => createProtocolChild(),
  });
  assert.equal(session.identity.threadId, "thread-a");
  assert.equal(session.identity.sessionId, "session-a");
  assert.equal(session.identity.planType, "pro");
  assert.equal((sink.frames[0].payload as { type: string }).type, "codex_session_bound");

  await runCodexDelegationTurn(session, { prompt: "implement it", cwd: "C:\\repo" });
  assert.deepEqual(sink.frames.map((frame) => frame.kind), ["raw", "text", "text", "raw"]);
  assert.equal((sink.frames[1].payload as { role: string }).role, "user");
  assert.equal((sink.frames[2].payload as { role: string }).role, "assistant");
  await closeCodexAppServerSession(session);
});

test("delegation fails closed on an event from another thread", async () => {
  const sink = new RecordingSink();
  const session = await startCodexAppServerSession({
    binary: "codex",
    cwd: "C:\\repo",
    env: {},
    sink,
    lictorVersion: "test",
    spawnProcess: () => createProtocolChild({ mismatch: true }),
  });
  await assert.rejects(
    runCodexDelegationTurn(session, { prompt: "implement it", cwd: "C:\\repo", turnTimeoutMs: 1_000 }),
    (error: unknown) => error instanceof CodexDelegationError && error.code === "codex_thread_mismatch",
  );
  session.client.terminate();
});
