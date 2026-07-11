import test from "node:test";
import assert from "node:assert/strict";
import { OrderedTranscriptSink, TranscriptSinkError } from "../src/transcript-sink.js";

test("OrderedTranscriptSink serializes posts and assigns monotonic seq", async () => {
  const bodies: Array<{ seq: number; kind: string }> = [];
  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const sink = new OrderedTranscriptSink({
    baseUrl: "http://127.0.0.1:17330",
    sessionId: "session-a",
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { seq: number; kind: string };
      bodies.push({ seq: body.seq, kind: body.kind });
      if (body.seq === 0) await firstGate;
      return new Response(JSON.stringify({ persisted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const first = sink.post("raw", { type: "bound" }, { requirePersisted: true });
  const second = sink.post("text", { role: "user", text: "hello" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bodies, [{ seq: 0, kind: "raw" }]);
  releaseFirst?.();

  assert.deepEqual(await first, { seq: 0, persisted: true });
  assert.deepEqual(await second, { seq: 1, persisted: true });
  assert.deepEqual(bodies, [
    { seq: 0, kind: "raw" },
    { seq: 1, kind: "text" },
  ]);
});

test("OrderedTranscriptSink retries transient HTTP failures without changing seq", async () => {
  const attempts: number[] = [];
  const sleeps: number[] = [];
  const sink = new OrderedTranscriptSink({
    baseUrl: "http://127.0.0.1:17330",
    sessionId: "session-b",
    maxAttempts: 2,
    retryBaseMs: 25,
    sleep: async (ms) => { sleeps.push(ms); },
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { seq: number };
      attempts.push(body.seq);
      if (attempts.length === 1) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ persisted: true }), { status: 200 });
    },
  });

  assert.deepEqual(await sink.post("raw", {}), { seq: 0, persisted: true });
  assert.deepEqual(attempts, [0, 0]);
  assert.deepEqual(sleeps, [25]);
});

test("OrderedTranscriptSink poisons later posts after required persistence fails", async () => {
  const sink = new OrderedTranscriptSink({
    baseUrl: "http://127.0.0.1:17330",
    sessionId: "session-c",
    fetchFn: async () => new Response(JSON.stringify({ persisted: false }), { status: 200 }),
  });

  await assert.rejects(
    sink.post("raw", {}, { requirePersisted: true }),
    (error: unknown) => error instanceof TranscriptSinkError && error.code === "transcript_sink_failed",
  );
  await assert.rejects(
    sink.post("text", {}),
    (error: unknown) => error instanceof TranscriptSinkError && error.code === "transcript_sink_failed",
  );
});
