import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPermissionDeferMs, startSidecar, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";
import { SkillInjector } from "../src/skill-injector.js";

async function withSidecar<T>(
  overrides: Partial<SidecarContext>,
  fn: (ctx: SidecarContext, port: number) => Promise<T>,
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
    ...overrides,
  };
  const sidecar = await startSidecar(ctx);
  try {
    return await fn(ctx, sidecar.port);
  } finally {
    sidecar.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
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
    const r = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { decision: string };
    assert.equal(j.decision, "allow");
  });
});

test("/v1/internal/permission-check returns 400 on missing tool_name", async () => {
  // We need concordia non-null to get past the early-allow path, but we
  // never let the request reach the network because tool_name is missing.
  const fakeConcordia = {
    permissionRequest: async () => ({}),
  } as unknown as SidecarContext["concordia"];
  await withSidecar({ concordia: fakeConcordia, sessionId: "s1" }, async (_ctx, port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_input: {} }),
    });
    assert.equal(r.status, 400);
  });
});

test("/v1/internal/permission-response resolves a pending check", async () => {
  const fakeConcordia = {
    permissionRequest: async () => ({}),
  } as unknown as SidecarContext["concordia"];
  await withSidecar({ concordia: fakeConcordia, sessionId: "s1" }, async (ctx, port) => {
    const checkPromise = fetch(`http://127.0.0.1:${port}/v1/internal/permission-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
    });
    // Wait briefly for the check to register a pending entry.
    await new Promise((r) => setTimeout(r, 50));
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
  });
});

test("self-processable permission is not posted when the transcript advances during defer", async () => {
  let permissionPosts = 0;
  let transcriptLines = 10;
  const fakeConcordia = {
    permissionRequest: async () => {
      permissionPosts += 1;
      return {};
    },
  } as unknown as SidecarContext["concordia"];
  await withSidecar({
    concordia: fakeConcordia,
    sessionId: "s1",
    getTranscript: () => ({
      path: "C:/transcript.jsonl",
      available: true,
      total_lines: transcriptLines,
      returned: 1,
      lines: [],
    }),
    permissionTiming: {
      deferMs: 5_000,
      sleep: async () => {
        transcriptLines += 1;
      },
    },
  }, async (_ctx, port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/internal/permission-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "Read", permission_mode: "acceptEdits", tool_input: { file_path: "a" } }),
    });
    assert.equal(r.status, 200);
    assert.equal(permissionPosts, 0);
    assert.equal((await r.json() as { decision: string }).decision, "allow");
  });
});

test("self-processable permission is posted after defer when the transcript is stalled", async () => {
  let permissionPosts = 0;
  const fakeConcordia = {
    permissionRequest: async () => {
      permissionPosts += 1;
      return {};
    },
  } as unknown as SidecarContext["concordia"];
  await withSidecar({
    concordia: fakeConcordia,
    sessionId: "s1",
    getTranscript: () => ({
      path: "C:/transcript.jsonl",
      available: true,
      total_lines: 10,
      returned: 1,
      lines: [],
    }),
    permissionTiming: { deferMs: 5_000, sleep: async () => undefined },
  }, async (ctx, port) => {
    const check = fetch(`http://127.0.0.1:${port}/v1/internal/permission-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "Read", permission_mode: "acceptEdits" }),
    });
    await waitForPendingPermission(ctx);
    assert.equal(permissionPosts, 1);
    await resolvePermission(port, ctx, "allow");
    assert.equal((await (await check).json() as { decision: string }).decision, "allow");
  });
});

test("user-confirmation posts immediately and waits for an explicit response", async () => {
  let permissionPosts = 0;
  let sleepCalls = 0;
  const fakeConcordia = {
    permissionRequest: async () => {
      permissionPosts += 1;
      return {};
    },
  } as unknown as SidecarContext["concordia"];
  await withSidecar({
    concordia: fakeConcordia,
    sessionId: "s1",
    permissionTiming: { deferMs: 5_000, sleep: async () => { sleepCalls += 1; } },
  }, async (ctx, port) => {
    const check = fetch(`http://127.0.0.1:${port}/v1/internal/permission-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", permission_mode: "default" }),
    });
    await waitForPendingPermission(ctx);
    assert.equal(permissionPosts, 1);
    assert.equal(sleepCalls, 0);
    await resolvePermission(port, ctx, "ask");
    const response = await (await check).json() as { decision: string; reason?: string };
    assert.equal(response.decision, "ask");
  });
});

async function waitForPendingPermission(ctx: SidecarContext): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
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
