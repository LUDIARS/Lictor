import { test } from "node:test";
import assert from "node:assert/strict";
import { ConcordiaClient, loadConcordiaConfig } from "../src/concordia.js";
import { ImplementationBindProxyError } from "../src/implementation-bind.js";

async function withFetch(reply: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = reply;
  try { await run(); } finally { globalThis.fetch = original; }
}

const bind = () => new ConcordiaClient(loadConcordiaConfig({ CONCORDIA_PORT: "11111" }))
  .bindImplementation("owner-session", { cwd: "/workspace/game", task: "repair" });

test("LI-BIND-01 forwards the owning session and preserves committed success", { concurrency: false }, async () => {
  await withFetch((async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:11111/v1/implementation-tools/bind");
    assert.deepEqual(JSON.parse(String(init?.body)), { cwd: "/workspace/game", task: "repair", session_id: "owner-session" });
    return Response.json({ ok: true, notification: "deferred" });
  }) as typeof fetch, async () => {
    assert.deepEqual(await bind(), { ok: true, notification: "deferred" });
  });
});

test("LI-BIND-01 preserves safe Cc rejection without forwarding extra diagnostics", { concurrency: false }, async () => {
  await withFetch((async () => Response.json({ error: "implementation_bind_failed",
    stage: "project", reason: "project_not_registered", binding: "unchanged",
    guidance: "secret-token", detail: "/private/path", cause: "raw exception" }, { status: 409 })) as typeof fetch,
  async () => {
    await assert.rejects(bind(), (error: unknown) => {
      assert.ok(error instanceof ImplementationBindProxyError);
      assert.equal(error.status, 409);
      assert.equal(error.body.reason, "project_not_registered");
      assert.equal(error.body.stage, "project");
      assert.equal(error.body.binding, "unchanged");
      assert.doesNotMatch(JSON.stringify(error.body), /secret-token|private|exception/);
      return true;
    });
  });
});

test("LI-BIND-01 legacy and unrecognized diagnostics do not assert unchanged state", { concurrency: false }, async () => {
  for (const extra of [{}, { reason: "/private/path", stage: "secret-token", binding: "invented" }]) {
    await withFetch((async () => Response.json({ error: "implementation_bind_failed", ...extra }, { status: 409 })) as typeof fetch,
    async () => {
      await assert.rejects(bind(), (error: unknown) => {
        assert.ok(error instanceof ImplementationBindProxyError);
        assert.equal(error.status, 409);
        assert.equal(error.body.reason, "unexpected_failure");
        assert.equal(error.body.stage, "unknown");
        assert.equal(error.body.binding, "unknown");
        assert.doesNotMatch(JSON.stringify(error.body), /private|secret-token/);
        return true;
      });
    });
  }
});

test("LI-BIND-01 transport or invalid upstream responses remain unknown and are not retried", { concurrency: false }, async () => {
  const replies = [
    async () => { throw new Error("private network diagnostics"); },
    async () => new Response("private non-json", { status: 409 }),
    async () => Response.json({ error: "private failure" }, { status: 500 }),
    async () => Response.json(null),
  ];
  for (const reply of replies) {
    let calls = 0;
    await withFetch((async () => { calls++; return reply(); }) as typeof fetch, async () => {
      await assert.rejects(bind(), (error: unknown) => {
        assert.ok(error instanceof ImplementationBindProxyError);
        assert.equal(error.status, 502);
        assert.equal(error.body.binding, "unknown");
        assert.doesNotMatch(JSON.stringify(error.body), /private/);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});
