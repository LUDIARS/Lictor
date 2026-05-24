import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeRenameArg, startSidecar, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";
import { SkillInjector } from "../src/skill-injector.js";

test("sanitizeRenameArg strips C0 controls", () => {
  assert.equal(sanitizeRenameArg("hello\x07world"), "helloworld");
  assert.equal(sanitizeRenameArg("a\x00b\x1bc"), "abc");
});

test("sanitizeRenameArg strips leading slashes", () => {
  assert.equal(sanitizeRenameArg("/rename evil"), "rename evil");
  assert.equal(sanitizeRenameArg("///foo"), "foo");
});

test("sanitizeRenameArg trims and caps length", () => {
  assert.equal(sanitizeRenameArg("  spaced  "), "spaced");
  assert.equal(sanitizeRenameArg("x".repeat(500)).length, 200);
});

test("sanitizeRenameArg preserves multibyte", () => {
  assert.equal(sanitizeRenameArg("[Li] 併走テスト 🛠"), "[Li] 併走テスト 🛠");
});

test("sanitizeRenameArg returns empty for control-only input", () => {
  assert.equal(sanitizeRenameArg("\x00\x07\x1b"), "");
  assert.equal(sanitizeRenameArg("   "), "");
});

async function withSidecar<T>(
  ctxOverrides: Partial<SidecarContext>,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const meta = gatherBaseMeta();
  const tmpRoot = mkdtempSync(join(tmpdir(), "lictor-rename-test-"));
  const injector = new SkillInjector("session-rename-test", tmpRoot);
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
    ...ctxOverrides,
  };
  const sidecar = await startSidecar(ctx);
  try {
    return await fn(sidecar.port);
  } finally {
    sidecar.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test("/v1/rename writes `/rename <text>\\r` to ptyWriter", async () => {
  const recorded: string[] = [];
  await withSidecar({ ptyWriter: (d) => recorded.push(d) }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "[Li] 併走テスト" }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; sent: string };
    assert.equal(body.ok, true);
    assert.equal(body.sent, "[Li] 併走テスト");
  });
  assert.deepEqual(recorded, ["/rename [Li] 併走テスト\r"]);
});

test("/v1/rename returns 503 when ptyWriter is null", async () => {
  await withSidecar({ ptyWriter: null }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ignored" }),
    });
    assert.equal(r.status, 503);
  });
});

test("/v1/rename returns 400 when text is missing or wrong type", async () => {
  await withSidecar({ ptyWriter: () => {} }, async (port) => {
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(r1.status, 400);

    const r2 = await fetch(`http://127.0.0.1:${port}/v1/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: 42 }),
    });
    assert.equal(r2.status, 400);
  });
});

test("/v1/rename returns 400 when text becomes empty after sanitization", async () => {
  await withSidecar({ ptyWriter: () => {} }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "\x00\x07   " }),
    });
    assert.equal(r.status, 400);
  });
});

test("/v1/rename strips leading slashes to prevent command chaining", async () => {
  const recorded: string[] = [];
  await withSidecar({ ptyWriter: (d) => recorded.push(d) }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "/clear" }),
    });
    assert.equal(r.status, 200);
  });
  // Should be `/rename clear\r`, NOT `/rename /clear\r` (which claude would
  // interpret as a different slash command after spaces collapse).
  assert.deepEqual(recorded, ["/rename clear\r"]);
});
