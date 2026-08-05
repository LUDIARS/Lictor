import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionShutdown } from "../src/session-shutdown.js";
import { startSidecar, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";

test("shutdown responds after unregister, kill, flush, and archive, then exits", async () => {
  const steps: string[] = [];
  const shutdown = new SessionShutdown({
    unregister: async () => {
      steps.push("unregister");
    },
    kill: async () => {
      steps.push("kill");
    },
    flush: async () => {
      steps.push("flush");
    },
    archive: async (reason) => {
      steps.push(`archive:${reason}`);
      return "/archive";
    },
    cleanup: async () => {
      steps.push("cleanup");
    },
    scheduleExit: () => {
      steps.push("exit");
    },
  });
  assert.deepEqual(
    await shutdown.run(
      { reason: "session-end" },
      async () => {
        steps.push("response");
      },
    ),
    { ok: true, archived: "/archive" },
  );
  assert.deepEqual(
    steps,
    ["unregister", "kill", "flush", "archive:session-end", "response", "cleanup", "exit"],
  );
});

test("shutdown is idempotent", async () => {
  let calls = 0;
  const shutdown = new SessionShutdown({
    unregister: async () => {
      calls++;
    },
    kill: () => {
      calls++;
    },
    archive: async () => {
      calls++;
      return null;
    },
    scheduleExit: () => {
      calls++;
    },
  });
  await shutdown.run();
  assert.deepEqual(await shutdown.run(), { ok: true, already: true });
  assert.equal(calls, 4);
});

test("shutdown skips termination when the wrapped CLI has already exited", async () => {
  let killed = false;
  const shutdown = new SessionShutdown({
    unregister: async () => undefined,
    isCliAlive: () => false,
    kill: () => {
      killed = true;
    },
    archive: async () => null,
    scheduleExit: () => undefined,
  });
  await shutdown.run();
  assert.equal(killed, false);
});

test("shutdown continues after unregister and archive failures", async () => {
  const steps: string[] = [];
  const warnings: string[] = [];
  const shutdown = new SessionShutdown({
    unregister: async () => {
      steps.push("unregister");
      throw new Error("Cc down");
    },
    kill: () => {
      steps.push("kill");
    },
    archive: async () => {
      steps.push("archive");
      throw new Error("disk full");
    },
    scheduleExit: () => {
      steps.push("exit");
    },
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(await shutdown.run(), { ok: true, archived: null });
  assert.deepEqual(steps, ["unregister", "kill", "archive", "exit"]);
  assert.equal(warnings.length, 2);
});

test("shutdown continues to exit after session resource cleanup fails", async () => {
  const steps: string[] = [];
  const warnings: string[] = [];
  const shutdown = new SessionShutdown({
    unregister: async () => undefined,
    kill: () => undefined,
    archive: async () => null,
    cleanup: async () => {
      steps.push("cleanup");
      throw new Error("cleanup failed");
    },
    scheduleExit: () => {
      steps.push("exit");
    },
    warn: (message) => warnings.push(message),
  });

  await shutdown.run();

  assert.deepEqual(steps, ["cleanup", "exit"]);
  assert.deepEqual(warnings, ["session resource cleanup failed: cleanup failed"]);
});

test("archive=false skips the archive stage", async () => {
  let archived = false;
  const shutdown = new SessionShutdown({
    unregister: async () => undefined,
    kill: () => undefined,
    archive: async () => {
      archived = true;
      return "/archive";
    },
    scheduleExit: () => undefined,
  });
  assert.deepEqual(await shutdown.run({ archive: false }), { ok: true, archived: null });
  assert.equal(archived, false);
});

test("POST /v1/shutdown returns already instead of 500 on a second call", async () => {
  const shutdown = new SessionShutdown({
    unregister: async () => undefined,
    kill: () => undefined,
    archive: async () => null,
    scheduleExit: () => undefined,
  });
  const ctx = {
    meta: gatherBaseMeta(),
    titleState: { manualOverride: null },
    concordia: null,
    sessionId: null,
    roleLabel: null,
    injector: null,
    ptyWriter: null,
    notifyState: { mark: null, expiresAt: null },
    conflictState: { count: 0, titleMark: null },
    taskState: { branch: null, desc: null, updatedAt: null },
    pendingPermissions: new Map(),
    shutdown,
  } as unknown as SidecarContext;
  const sidecar = await startSidecar(ctx);
  try {
    const url = `http://127.0.0.1:${sidecar.port}/v1/shutdown`;
    const first = await fetch(url, { method: "POST", body: "{}" });
    const second = await fetch(url, { method: "POST", body: "{}" });
    assert.deepEqual(await first.json(), { ok: true, archived: null });
    assert.deepEqual(await second.json(), { ok: true, already: true });
  } finally {
    sidecar.close();
  }
});
