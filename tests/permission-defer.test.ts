import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionDeferObserver,
  transcriptProgressed,
  type DeferScheduler,
  type DeferredPermissionRequest,
  type TranscriptProgressSnapshot,
} from "../src/permission-defer.js";

function snapshot(overrides: Partial<TranscriptProgressSnapshot> = {}): TranscriptProgressSnapshot {
  return { path: "C:/transcript.jsonl", totalLines: 10, available: true, ...overrides };
}

const REQUEST: DeferredPermissionRequest = {
  requestId: "req-1",
  toolName: "Read",
  toolInput: { file_path: "a" },
};

/** Records armed timers without ever firing them on its own. */
class RecordingScheduler implements DeferScheduler {
  readonly armed: Array<{ ms: number; fn: () => void }> = [];
  cancelCount = 0;

  readonly setTimer = (ms: number, fn: () => void): (() => void) => {
    this.armed.push({ ms, fn });
    return () => {
      this.cancelCount += 1;
    };
  };
}

interface ObserverProbe {
  observer: PermissionDeferObserver;
  scheduler: RecordingScheduler;
  progressed: DeferredPermissionRequest[];
  stalled: DeferredPermissionRequest[];
}

function buildObserver(reads: Array<TranscriptProgressSnapshot | null>): ObserverProbe {
  const scheduler = new RecordingScheduler();
  const progressed: DeferredPermissionRequest[] = [];
  const stalled: DeferredPermissionRequest[] = [];
  const queue = [...reads];
  const observer = new PermissionDeferObserver({
    deferMs: 5_000,
    scheduler,
    readProgress: () => (queue.length > 0 ? (queue.shift() as TranscriptProgressSnapshot | null) : null),
    onProgressed: (request) => progressed.push(request),
    onStalled: (request) => stalled.push(request),
  });
  return { observer, scheduler, progressed, stalled };
}

test("transcriptProgressed detects new lines and a rotated transcript path", () => {
  assert.equal(transcriptProgressed(snapshot(), snapshot({ totalLines: 11 })), true);
  assert.equal(transcriptProgressed(snapshot(), snapshot({ path: "C:/other.jsonl" })), true);
  assert.equal(transcriptProgressed(snapshot(), snapshot()), false);
  // A shrinking transcript is not progress.
  assert.equal(transcriptProgressed(snapshot(), snapshot({ totalLines: 9 })), false);
});

test("transcriptProgressed reports no progress when the transcript is unobservable", () => {
  // Unobservable must fall back to notifying a human, never to silence.
  assert.equal(transcriptProgressed(null, snapshot()), false);
  assert.equal(transcriptProgressed(snapshot(), null), false);
  assert.equal(transcriptProgressed(snapshot({ available: false }), snapshot()), false);
  assert.equal(transcriptProgressed(snapshot(), snapshot({ available: false, totalLines: 12 })), false);
});

test("observe arms the defer window without calling back synchronously", () => {
  const probe = buildObserver([snapshot(), snapshot({ totalLines: 12 })]);
  probe.observer.observe(REQUEST);

  assert.equal(probe.scheduler.armed.length, 1);
  assert.equal(probe.scheduler.armed[0].ms, 5_000);
  assert.equal(probe.observer.pendingCount, 1);
  assert.equal(probe.progressed.length, 0);
  assert.equal(probe.stalled.length, 0);
});

test("a progressed transcript resolves the observation without notifying", () => {
  const probe = buildObserver([snapshot(), snapshot({ totalLines: 12 })]);
  probe.observer.observe(REQUEST);
  probe.scheduler.armed[0].fn();

  assert.deepEqual(probe.progressed, [REQUEST]);
  assert.equal(probe.stalled.length, 0);
  assert.equal(probe.observer.pendingCount, 0);
});

test("a stalled transcript notifies exactly once", () => {
  const probe = buildObserver([snapshot(), snapshot()]);
  probe.observer.observe(REQUEST);
  probe.scheduler.armed[0].fn();

  assert.deepEqual(probe.stalled, [REQUEST]);
  assert.equal(probe.progressed.length, 0);
  assert.equal(probe.observer.pendingCount, 0);
});

test("dispose cancels armed observations and silences late callbacks", () => {
  const probe = buildObserver([snapshot(), snapshot()]);
  probe.observer.observe(REQUEST);
  const lateCallback = probe.scheduler.armed[0].fn;

  probe.observer.dispose();

  assert.equal(probe.scheduler.cancelCount, 1);
  assert.equal(probe.observer.pendingCount, 0);

  // A callback that already escaped the cancel must still do nothing.
  lateCallback();
  assert.equal(probe.stalled.length, 0);
  assert.equal(probe.progressed.length, 0);
});

test("observe is a no-op after dispose", () => {
  const probe = buildObserver([snapshot(), snapshot()]);
  probe.observer.dispose();
  probe.observer.observe(REQUEST);

  assert.equal(probe.scheduler.armed.length, 0);
  assert.equal(probe.observer.pendingCount, 0);
});

test("dispose keeps going when a cancel handle throws", () => {
  const failing: DeferScheduler = {
    setTimer: () => () => {
      throw new Error("cancel exploded");
    },
  };
  const stalled: DeferredPermissionRequest[] = [];
  const observer = new PermissionDeferObserver({
    deferMs: 1,
    scheduler: failing,
    readProgress: () => snapshot(),
    onProgressed: () => {},
    onStalled: (request) => stalled.push(request),
  });
  observer.observe(REQUEST);
  observer.observe({ ...REQUEST, requestId: "req-2" });

  observer.dispose();

  assert.equal(observer.pendingCount, 0);
  assert.equal(stalled.length, 0);
});
