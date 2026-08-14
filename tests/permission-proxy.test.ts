import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSidecar, type Sidecar, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";
import { SkillInjector } from "../src/skill-injector.js";
import { PermissionPendingBuffer } from "../src/permission-pending.js";

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

async function postNotification(port: number, message: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/internal/notification`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

test("/v1/internal/permission-check stays observation-only when concordia is null", async () => {
  const pending = new PermissionPendingBuffer();
  await withSidecar({ concordia: null, permissionPending: pending }, async (_ctx, port) => {
    const r = await postPermissionCheck(port, { tool_name: "Bash", tool_input: { command: "ls" } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { deferred?: boolean; decision?: string };
    assert.equal(body.deferred, true);
    assert.equal(body.decision, undefined);
    assert.equal(pending.size, 1);
  });
});

test("/v1/internal/permission-check returns 400 on missing tool_name", async () => {
  const counter = { posts: 0 };
  await withSidecar(
    { concordia: countingConcordia(counter), sessionId: "s1" },
    async (_ctx, port) => {
      const r = await postPermissionCheck(port, { tool_input: { command: "ls" } });
      assert.equal(r.status, 400);
      assert.equal(counter.posts, 0);
    },
  );
});

test("どの permission mode でも decision は返さず、カードも出さない", async () => {
  // hook は Claude の許可判定より前に走る。 ここでカードを出すと settings.json で
  // 自動許可されるものまで人間に聞くことになる (2026-08-14 の実害)。
  for (const mode of ["auto", "default", "acceptEdits", "bypassPermissions", undefined]) {
    const counter = { posts: 0 };
    await withSidecar(
      { concordia: countingConcordia(counter), sessionId: `s-${String(mode)}` },
      async (_ctx, port) => {
        const r = await postPermissionCheck(port, {
          tool_name: "Bash",
          tool_input: { command: "git status" },
          permission_mode: mode,
        });
        const body = (await r.json()) as { deferred?: boolean; decision?: string };
        assert.equal(body.deferred, true, `mode=${String(mode)} は hook を掴んではいけない`);
        assert.equal(body.decision, undefined);
        assert.equal(counter.posts, 0, `mode=${String(mode)} でカードを出してはいけない`);
      },
    );
  }
});

test("許可待ちの Notification が来たときだけカードが出る", async () => {
  const counter = { posts: 0 };
  await withSidecar(
    { concordia: countingConcordia(counter), sessionId: "s-auto" },
    async (_ctx, port) => {
      await postPermissionCheck(port, {
        tool_name: "Bash",
        tool_input: { command: "git status" },
        permission_mode: "auto",
      });
      assert.equal(counter.posts, 0);

      const notified = await postNotification(port, "Claude needs your permission to use Bash");
      const body = (await notified.json()) as { posted: boolean; matched: boolean };
      assert.equal(body.posted, true);
      assert.equal(body.matched, true);
      assert.equal(counter.posts, 1);
    },
  );
});

test("/v1/internal/notification: 待機催促ではカードを出さない", async () => {
  const counter = { posts: 0 };
  await withSidecar(
    { concordia: countingConcordia(counter), sessionId: "s-idle" },
    async (_ctx, port) => {
      const res = await postNotification(port, "Claude is waiting for your input");
      const body = (await res.json()) as { kind: string; posted: boolean };
      assert.equal(body.kind, "idle");
      assert.equal(body.posted, false);
      assert.equal(counter.posts, 0);
    },
  );
});

test("permission-response は打鍵で回答する", async () => {
  const counter = { posts: 0 };
  const keys: string[] = [];
  await withSidecar(
    {
      concordia: countingConcordia(counter),
      sessionId: "s-answer",
      ptyWriter: (data: string) => keys.push(data),
    },
    async (_ctx, port) => {
      const notified = await postNotification(port, "Claude needs your permission to use Bash");
      const { request_id: requestId } = (await notified.json()) as { request_id: string };

      const answered = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: requestId, decision: "allow" }),
      });
      assert.equal(answered.status, 200);
      assert.deepEqual((await answered.json()) as { via: string }, { ok: true, via: "keystroke" });
      assert.deepEqual(keys, ["\r"]);
    },
  );
});

test("/v1/internal/permission-response returns 404 for unknown request_id", async () => {
  await withSidecar({}, async (_ctx, port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "does-not-exist", decision: "allow" }),
    });
    assert.equal(r.status, 404);
  });
});

test("/v1/internal/permission-response rejects bad decision values", async () => {
  await withSidecar({}, async (_ctx, port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "x", decision: "maybe" }),
    });
    assert.equal(r.status, 400);
  });
});

test("Concordia transport errors は外に出さない", async () => {
  const transportDetail = "private coordinator diagnostic";
  const failingConcordia = {
    permissionRequest: async () => {
      throw new Error(`request failed: ${transportDetail}`);
    },
  } as unknown as SidecarContext["concordia"];

  await withSidecar(
    { concordia: failingConcordia, sessionId: "s1" },
    async (_ctx, port) => {
      const res = await postNotification(port, "Claude needs your permission to use Bash");
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.ok(!text.includes(transportDetail));
      assert.ok(text.includes('"posted":false'));
    },
  );
});
