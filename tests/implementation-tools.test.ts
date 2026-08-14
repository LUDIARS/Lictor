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
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "lictor-implementation-tools-"));
  const injector = new SkillInjector("session-implementation-tools", tmpRoot);
  const ctx: SidecarContext = {
    meta: gatherBaseMeta(),
    titleState: { manualOverride: null },
    concordia: null,
    sessionId: null,
    roleLabel: null,
    injector,
    ptyWriter: null,
    notifyState: { mark: null, expiresAt: null },
    conflictState: { count: 0, titleMark: null },
    taskState: { branch: null, desc: null, updatedAt: null },
    ...overrides,
  };
  const sidecar = await startSidecar(ctx);
  try {
    return await fn(sidecar.port);
  } finally {
    sidecar.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test("implementation and direct PR tools require a registered Concordia session", async () => {
  await withSidecar({}, async (port) => {
    for (const path of [
      "/v1/implementation-tools/bind",
      "/v1/implementation-tools/service",
      "/v1/implementation-tools/review",
      "/v1/pr/submit",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(response.status, 503);
    }
  });
});

test("implementation and direct PR tools validate input and forward the authoritative session id", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const concordia = {
    bindImplementation: async (...args: unknown[]) => {
      calls.push({ method: "bind", args });
      return { ok: true };
    },
    controlImplementationService: async (...args: unknown[]) => {
      calls.push({ method: "service", args });
      return { ok: true };
    },
    submitImplementationReview: async (...args: unknown[]) => {
      calls.push({ method: "review", args });
      return { ok: true };
    },
    submitDirectLocalPr: async (...args: unknown[]) => {
      calls.push({ method: "direct-pr", args });
      return { ok: true };
    },
  } as unknown as SidecarContext["concordia"];

  await withSidecar({ concordia, sessionId: "session-123" }, async (port) => {
    const invalidBind = await fetch(`http://127.0.0.1:${port}/v1/implementation-tools/bind`, {
      method: "POST",
      body: JSON.stringify({ cwd: "   ", task: "   " }),
    });
    assert.equal(invalidBind.status, 400);

    const invalidService = await fetch(`http://127.0.0.1:${port}/v1/implementation-tools/service`, {
      method: "POST",
      body: JSON.stringify({ service_code: "Li", action: "restart", note: 1 }),
    });
    assert.equal(invalidService.status, 400);
    assert.deepEqual(calls, []);

    const bind = await fetch(`http://127.0.0.1:${port}/v1/implementation-tools/bind`, {
      method: "POST",
      body: JSON.stringify({ cwd: "C:\\work\\Lictor", task: "Fix review workflow" }),
    });
    assert.equal(bind.status, 200);

    const service = await fetch(`http://127.0.0.1:${port}/v1/implementation-tools/service`, {
      method: "POST",
      body: JSON.stringify({ service_code: "Li", action: "restart", note: "verify fix" }),
    });
    assert.equal(service.status, 200);

    const review = await fetch(`http://127.0.0.1:${port}/v1/implementation-tools/review`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(review.status, 200);

    const malformedDirectPr = await fetch(`http://127.0.0.1:${port}/v1/pr/submit`, {
      method: "POST",
      body: "{",
    });
    assert.equal(malformedDirectPr.status, 400);

    const invalidDirectPr = await fetch(`http://127.0.0.1:${port}/v1/pr/submit`, {
      method: "POST",
      body: JSON.stringify({ repo_path: "   " }),
    });
    assert.equal(invalidDirectPr.status, 400);

    const invalidDirectPrBranch = await fetch(`http://127.0.0.1:${port}/v1/pr/submit`, {
      method: "POST",
      body: JSON.stringify({ repo_path: "C:\\work\\Lictor", branch: "   " }),
    });
    assert.equal(invalidDirectPrBranch.status, 400);

    const invalidDirectPrBranchType = await fetch(`http://127.0.0.1:${port}/v1/pr/submit`, {
      method: "POST",
      body: JSON.stringify({ repo_path: "C:\\work\\Lictor", branch: null }),
    });
    assert.equal(invalidDirectPrBranchType.status, 400);

    const directPr = await fetch(`http://127.0.0.1:${port}/v1/pr/submit`, {
      method: "POST",
      body: JSON.stringify({ repo_path: " C:\\work\\Lictor ", branch: " feature/direct-pr " }),
    });
    assert.equal(directPr.status, 200);
  });

  assert.deepEqual(calls, [
    {
      method: "bind",
      args: ["session-123", { cwd: "C:\\work\\Lictor", task: "Fix review workflow" }],
    },
    {
      method: "service",
      args: ["session-123", { service_code: "Li", action: "restart", note: "verify fix" }],
    },
    { method: "review", args: ["session-123"] },
    {
      method: "direct-pr",
      args: ["session-123", { repo_path: "C:\\work\\Lictor", branch: "feature/direct-pr" }],
    },
  ]);
});
