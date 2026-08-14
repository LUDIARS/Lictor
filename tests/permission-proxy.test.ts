import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPermissionDeferMs,
  startSidecar,
  type Sidecar,
  type SidecarContext,
} from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";
import { SkillInjector } from "../src/skill-injector.js";

interface ArmedTimer {
  id: number;
  ms: number;
  fn: () => void;
}

/**
 * Deterministic stand-in for setTimeout plus a logical clock.
 *
 * Nothing fires on its own, so a handler that (incorrectly) waited for the
 * defer window would hang instead of quietly passing. `stamp()` orders
 * observable events without touching wall-clock time.
 */
class ManualScheduler {
  readonly timers = new Map<number, ArmedTimer>();
  readonly cancelled: number[] = [];
  private nextId = 1;
  private tick = 0;

  readonly setTimer = (ms: number, fn: () => void): (() => void) => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { id, ms, fn });
    return () => {
      if (this.timers.delete(id)) this.cancelled.push(id);
    };
  };

  get pendingCount(): number {
    return this.timers.size;
  }

  armed(): ArmedTimer[] {
    return [...this.timers.values()];
  }

  /** Advance the logical clock and return the new value. */
  stamp(): number {
    this.tick += 1;
    return this.tick;
  }

  /** Fire every armed timer in arming order. */
  runAll(): void {
    const due = this.armed();
    this.timers.clear();
    for (const timer of due) timer.fn();
  }
}

async function withSidecar<T>(
  overrides: Partial<SidecarContext>,
  fn: (ctx: SidecarContext, port: number, sidecar: Sidecar) => Promise<T>,
): Promise<T> {
  const meta = gatherBaseMeta();
  const tmpRoot = mkdtempSync(join(tmpdir(), "lictor-perm-test-"));
  const injector = new SkillInjector("session-perm", tmpRoot);
  const ctx: SidecarContext = {
    meta,
    titleState: { manualOverride: null },
    concordia: null,
    sessionId: null,
    roleLabel: null,
    injector,
    ptyWriter: null,
    notifyState: { mark: null, expiresAt: null },
    conflictState: { count: 0, titleMark: null },
    taskState: { branch: null, desc: null, updatedAt: null },
    pendingPermissions: new Map(),
    // 監査はテストでは書かない (実運用の state dir を汚さない)。
    permissionAudit: { path: null, write: () => {} },
    ...overrides,
  };
  const sidecar = await startSidecar(ctx);
  try {
    return await fn(ctx, sidecar.port, sidecar);
  } finally {
    sidecar.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function countingConcordia(counter: { posts: number }): SidecarContext["concordia"] {
  return {
    permissionRequest: async () => {
      counter.posts += 1;
      return {};
    },
  } as unknown as SidecarContext["concordia"];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function postPermissionCheck(
  port: number,
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/internal/permission-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("readPermissionDeferMs accepts non-negative finite values and falls back safely", () => {
  assert.equal(readPermissionDeferMs({ PERMISSION_DEFER_MS: "0" }), 0);
  assert.equal(readPermissionDeferMs({ PERMISSION_DEFER_MS: "125" }), 125);
  assert.equal(readPermissionDeferMs({ PERMISSION_DEFER_MS: "-1" }), 5_000);
  assert.equal(readPermissionDeferMs({ PERMISSION_DEFER_MS: "Infinity" }), 5_000);
  assert.equal(readPermissionDeferMs({}), 5_000);
});

test("/v1/internal/permission-check defaults to allow when concordia is null", async () => {
  await withSidecar({ concordia: null }, async (_ctx, port) => {
    const r = await postPermissionCheck(port, { tool_name: "Bash", tool_input: { command: "ls" } });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { decision: string };
    assert.equal(j.decision, "allow");
  });
});

test("/v1/internal/permission-check does not expose Concordia transport errors", async () => {
  const transportDetail = "private coordinator diagnostic";
  const failingConcordia = {
    permissionRequest: async () => {
      throw new Error(`request failed: ${transportDetail}`);
    },
  } as unknown as SidecarContext["concordia"];

  await withSidecar(
    { concordia: failingConcordia, sessionId: "s1" },
    async (_ctx, port) => {
      const response = await postPermissionCheck(port, {
        tool_name: "Bash",
        permission_mode: "default",
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as { decision: string; reason: string };
      assert.equal(body.decision, "allow");
      assert.equal(body.reason, "concordia unreachable");
      assert.equal(body.reason.includes(transportDetail), false);
    },
  );
});

test("/v1/internal/permission-check returns 400 on missing tool_name", async () => {
  // We need concordia non-null to get past the early-allow path, but we
  // never let the request reach the network because tool_name is missing.
  const counter = { posts: 0 };
  await withSidecar(
    { concordia: countingConcordia(counter), sessionId: "s1" },
    async (_ctx, port) => {
      const r = await postPermissionCheck(port, { tool_input: {} });
      assert.equal(r.status, 400);
    },
  );
});

test("/v1/internal/permission-response resolves a pending check", async () => {
  const counter = { posts: 0 };
  await withSidecar(
    { concordia: countingConcordia(counter), sessionId: "s1" },
    async (ctx, port) => {
      const checkPromise = postPermissionCheck(port, {
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      await waitForPendingPermission(ctx);
      const ids = [...ctx.pendingPermissions.keys()];
      assert.equal(ids.length, 1);
      const respondR = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: ids[0], decision: "deny", reason: "test" }),
      });
      assert.equal(respondR.status, 200);
      const checkR = await checkPromise;
      assert.equal(checkR.status, 200);
      const j = (await checkR.json()) as { decision: string; reason?: string };
      assert.equal(j.decision, "deny");
      assert.equal(j.reason, "test");
      // pending map cleared
      assert.equal(ctx.pendingPermissions.size, 0);
    },
  );
});

test("self-processable releases the hook before the defer window is observed", async () => {
  // The PreToolUse hook blocks the tool call, so the sidecar must answer
  // first and look at the transcript afterwards. The logical clock below
  // pins that order: the response is stamped between the two progress reads.
  const scheduler = new ManualScheduler();
  const counter = { posts: 0 };
  const progressReads: number[] = [];

  await withSidecar(
    {
      concordia: countingConcordia(counter),
      sessionId: "s1",
      getTranscript: () => {
        progressReads.push(scheduler.stamp());
        return { path: "C:/transcript.jsonl", available: true, total_lines: 10, returned: 1, lines: [] };
      },
      permissionTiming: { deferMs: 5_000, scheduler },
    },
    async (_ctx, port) => {
      const r = await postPermissionCheck(port, {
        tool_name: "Read",
        permission_mode: "acceptEdits",
        tool_input: { file_path: "a" },
      });
      const responseTick = scheduler.stamp();

      assert.equal(r.status, 200);
      const body = (await r.json()) as { deferred?: boolean; decision?: string };
      // No decision at all — claude's own permission engine handles it.
      assert.equal(body.deferred, true);
      assert.equal(body.decision, undefined);
      // The defer window is still armed, i.e. the response never waited on it.
      assert.equal(scheduler.pendingCount, 1);
      assert.equal(scheduler.armed()[0].ms, 5_000);
      assert.equal(counter.posts, 0);
      assert.equal(progressReads.length, 1);
      assert.ok(progressReads[0] < responseTick, "baseline snapshot precedes the response");

      scheduler.runAll();
      await settle();
      assert.equal(progressReads.length, 2);
      assert.ok(progressReads[1] > responseTick, "the defer observation runs after the response");
    },
  );
});

test("deferred self-processable request is not posted when the transcript advanced", async () => {
  const scheduler = new ManualScheduler();
  const counter = { posts: 0 };
  let totalLines = 10;

  await withSidecar(
    {
      concordia: countingConcordia(counter),
      sessionId: "s1",
      getTranscript: () => ({
        path: "C:/transcript.jsonl",
        available: true,
        total_lines: totalLines,
        returned: 1,
        lines: [],
      }),
      permissionTiming: { deferMs: 5_000, scheduler },
    },
    async (_ctx, port) => {
      const r = await postPermissionCheck(port, {
        tool_name: "Read",
        permission_mode: "acceptEdits",
      });
      assert.equal(r.status, 200);

      // The hook is released, so the legacy auto-like mode runs the tool and
      // the transcript gains the tool_use / tool_result frames.
      totalLines += 2;
      scheduler.runAll();
      await settle();

      assert.equal(counter.posts, 0);
    },
  );
});

test("deferred self-processable request is posted when the transcript stalled", async () => {
  const scheduler = new ManualScheduler();
  const counter = { posts: 0 };

  await withSidecar(
    {
      concordia: countingConcordia(counter),
      sessionId: "s1",
      getTranscript: () => ({
        path: "C:/transcript.jsonl",
        available: true,
        total_lines: 10,
        returned: 1,
        lines: [],
      }),
      permissionTiming: { deferMs: 5_000, scheduler },
    },
    async (_ctx, port) => {
      const r = await postPermissionCheck(port, {
        tool_name: "Read",
        permission_mode: "acceptEdits",
      });
      assert.equal(r.status, 200);
      assert.equal(counter.posts, 0);

      // The transcript never moved: claude is asking a human in the TUI.
      scheduler.runAll();
      await settle();

      assert.equal(counter.posts, 1);
    },
  );
});

test("user-confirmation posts immediately and waits for an explicit response", async () => {
  const scheduler = new ManualScheduler();
  const counter = { posts: 0 };
  let settledEarly = false;

  await withSidecar(
    {
      concordia: countingConcordia(counter),
      sessionId: "s1",
      permissionTiming: { deferMs: 5_000, scheduler },
    },
    async (ctx, port) => {
      const check = postPermissionCheck(port, {
        tool_name: "Bash",
        permission_mode: "default",
      }).then((r) => {
        settledEarly = true;
        return r;
      });
      await waitForPendingPermission(ctx);

      assert.equal(counter.posts, 1);
      // No defer window is involved on the human-confirmation path.
      assert.equal(scheduler.pendingCount, 0);
      // The hook is still blocked, waiting for a human.
      assert.equal(settledEarly, false);

      await resolvePermission(port, ctx, "ask");
      const response = (await (await check).json()) as { decision: string; reason?: string };
      assert.equal(response.decision, "ask");
    },
  );
});

test("closing the sidecar cancels armed defer observations", async () => {
  const scheduler = new ManualScheduler();
  const counter = { posts: 0 };

  await withSidecar(
    {
      concordia: countingConcordia(counter),
      sessionId: "s1",
      getTranscript: () => ({
        path: "C:/transcript.jsonl",
        available: true,
        total_lines: 10,
        returned: 1,
        lines: [],
      }),
      permissionTiming: { deferMs: 5_000, scheduler },
    },
    async (_ctx, port, sidecar) => {
      const r = await postPermissionCheck(port, {
        tool_name: "Read",
        permission_mode: "acceptEdits",
      });
      assert.equal(r.status, 200);
      assert.equal(scheduler.pendingCount, 1);
      const armedFn = scheduler.armed()[0].fn;

      sidecar.close();

      // The timer was cancelled rather than left to leak.
      assert.equal(scheduler.pendingCount, 0);
      assert.equal(scheduler.cancelled.length, 1);

      // Even a callback that already escaped cancellation must stay silent.
      armedFn();
      await settle();
      assert.equal(counter.posts, 0);
    },
  );
});

async function waitForPendingPermission(ctx: SidecarContext): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (ctx.pendingPermissions.size > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("permission check did not register a pending request");
}

async function resolvePermission(
  port: number,
  ctx: SidecarContext,
  decision: "allow" | "deny" | "ask",
): Promise<void> {
  const requestId = [...ctx.pendingPermissions.keys()][0];
  const r = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, decision }),
  });
  assert.equal(r.status, 200);
}

test("/v1/internal/permission-response returns 404 for unknown request_id", async () => {
  await withSidecar({}, async (_ctx, port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "no-such-id", decision: "allow" }),
    });
    assert.equal(r.status, 404);
  });
});

test("/v1/internal/permission-response rejects bad decision values", async () => {
  await withSidecar({}, async (_ctx, port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "x", decision: "yes please" }),
    });
    assert.equal(r.status, 400);
  });
});

test("auto mode: permission-check は decision を返さず、 Notification が来るまでカードも出ない", async () => {
  const counter = { posts: 0 };
  await withSidecar(
    { concordia: countingConcordia(counter), sessionId: "s-auto" },
    async (_ctx, port) => {
      const check = await postPermissionCheck(port, {
        tool_name: "Bash",
        tool_input: { command: "git status" },
        permission_mode: "auto",
      });
      const body = (await check.json()) as { deferred?: boolean; decision?: string };
      assert.equal(body.deferred, true);
      assert.equal(body.decision, undefined);
      assert.equal(counter.posts, 0, "全コマンドでカードを出してはいけない");

      // 実際に許可待ちで止まったときだけカードが出る。
      const notified = await fetch(`http://127.0.0.1:${port}/v1/internal/notification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Claude needs your permission to use Bash" }),
      });
      const notifiedBody = (await notified.json()) as { posted: boolean; matched: boolean };
      assert.equal(notifiedBody.posted, true);
      assert.equal(notifiedBody.matched, true);
      assert.equal(counter.posts, 1);
    },
  );
});

test("/v1/internal/notification: 待機催促ではカードを出さない", async () => {
  const counter = { posts: 0 };
  await withSidecar(
    { concordia: countingConcordia(counter), sessionId: "s-idle" },
    async (_ctx, port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/internal/notification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Claude is waiting for your input" }),
      });
      const body = (await res.json()) as { kind: string; posted: boolean };
      assert.equal(body.kind, "idle");
      assert.equal(body.posted, false);
      assert.equal(counter.posts, 0);
    },
  );
});

test("permission-response: Notification 起点の要求は打鍵で回答する", async () => {
  const counter = { posts: 0 };
  const keys: string[] = [];
  await withSidecar(
    {
      concordia: countingConcordia(counter),
      sessionId: "s-answer",
      ptyWriter: (data: string) => keys.push(data),
    },
    async (_ctx, port) => {
      const notified = await fetch(`http://127.0.0.1:${port}/v1/internal/notification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Claude needs your permission to use Bash" }),
      });
      const { request_id: requestId } = (await notified.json()) as { request_id: string };

      const answered = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: requestId, decision: "allow" }),
      });
      assert.equal(answered.status, 200);
      assert.deepEqual((await answered.json()) as { via: string }, { ok: true, via: "keystroke" });
      assert.deepEqual(keys, ["\r"]);

      // 未知の request_id は従来どおり 404。
      const unknown = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: "nope", decision: "allow" }),
      });
      assert.equal(unknown.status, 404);
    },
  );
});
