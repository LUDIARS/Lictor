import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSidecar, type SidecarContext } from "../src/sidecar.js";
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
