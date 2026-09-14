import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptPathReport } from "../src/transcript-path-report.js";

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

test("stop cancels a send that has not started yet", async () => {
  let calls = 0;
  const report = new TranscriptPathReport(() => { calls++; }, () => {});
  report.offer("a.jsonl");
  report.stop();
  await drain();
  assert.equal(calls, 0);
});

test("failed path delivery retries without new transcript bytes", async () => {
  let now = 0;
  const attempts: string[] = [];
  const report = new TranscriptPathReport(async (path) => {
    attempts.push(path);
    if (attempts.length === 1) throw new Error("offline");
  }, () => {}, () => now);
  report.offer("a.jsonl");
  await drain();
  report.flush();
  assert.equal(attempts.length, 1);
  now = 1000;
  report.flush();
  await drain();
  report.flush();
  assert.deepEqual(attempts, ["a.jsonl", "a.jsonl"]);
  report.stop();
});

test("serializes path rotation and drops intermediate queued paths", async () => {
  let complete!: () => void;
  const attempts: string[] = [];
  const report = new TranscriptPathReport((path) => {
    attempts.push(path);
    if (path === "a.jsonl") return new Promise<void>((resolve) => { complete = resolve; });
  }, () => {});
  report.offer("a.jsonl");
  await drain();
  report.offer("b.jsonl");
  report.offer("c.jsonl");
  assert.deepEqual(attempts, ["a.jsonl"]);
  complete();
  await drain();
  report.flush();
  await drain();
  assert.deepEqual(attempts, ["a.jsonl", "c.jsonl"]);
  report.stop();
  report.offer("d.jsonl");
  report.flush();
  await drain();
  assert.equal(attempts.length, 2);
});
