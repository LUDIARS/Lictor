import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionRuntime, type PermissionHost, type PermissionRuntimeOptions } from "../src/permission-runtime.js";
import type { PermissionAuditEntry, PermissionAuditWriter } from "../src/permission-audit.js";

interface Harness {
  runtime: PermissionRuntime;
  entries: PermissionAuditEntry[];
  posted: { request_id: string; tool_name: string; tool_input: unknown }[];
  keys: string[];
}

function makeHarness(overrides: Partial<PermissionHost> = {}, options: PermissionRuntimeOptions = {}): Harness {
  const entries: PermissionAuditEntry[] = [];
  const posted: Harness["posted"] = [];
  const keys: string[] = [];
  const audit: PermissionAuditWriter = { path: null, write: (entry) => entries.push(entry) };
  const host: PermissionHost = {
    sessionId: "lictor-test",
    cwd: process.cwd(),
    concordia: {
      permissionRequest: async (_id, payload) => {
        posted.push(payload);
        return {};
      },
    },
    ptyWriter: (data) => keys.push(data),
    ...overrides,
  };
  const runtime = new PermissionRuntime(host, { ...options, audit, loadLayers: () => [] });
  return { runtime, entries, posted, keys };
}

test("PreToolUse はどの mode でも記録するだけでカードを出さない", async () => {
  // mode で分岐して hook を掴むと、 Claude が settings.json で自動許可するものにも
  // カードが出る (2026-08-14 に非 auto セッションで実害)。
  for (const mode of ["auto", "default", "acceptEdits", "bypassPermissions", undefined]) {
    const h = makeHarness();
    const outcome = h.runtime.observeCheck({
      tool_name: "Bash",
      tool_input: { command: "git status" },
      permission_mode: mode,
    });
    assert.equal(outcome.deferred, true, `mode=${String(mode)} は hook を掴んではいけない`);
    assert.equal(h.posted.length, 0, `mode=${String(mode)} でカードが出てはいけない`);
    assert.equal(h.entries.at(-1)?.outcome, "auto-allowed");
    assert.equal(h.entries.at(-1)?.permission_mode, mode ?? null);
  }
});

test("許可待ちの Notification が来たときだけカードが出る", async () => {
  const h = makeHarness();
  h.runtime.observeCheck(
    { tool_name: "Bash", tool_input: { command: "rm -rf build" }, permission_mode: "auto" }
  );

  // 待機催促ではカードを出さない。
  const idle = await h.runtime.handleNotification("Claude is waiting for your input");
  assert.equal(idle.posted, false);
  assert.equal(h.posted.length, 0);

  const permission = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  assert.equal(permission.posted, true);
  assert.equal(permission.matched, true);
  assert.equal(h.posted.length, 1);
  // 直前の観測と突き合わせて実コマンドが載る。
  assert.deepEqual(h.posted[0].tool_input, { command: "rm -rf build" });
  assert.equal(h.entries.at(-1)?.outcome, "prompted");
});

test("突き合わせに失敗しても「止まっている」事実は投稿する", async () => {
  const h = makeHarness();
  const outcome = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  assert.equal(outcome.posted, true);
  assert.equal(outcome.matched, false);
  assert.equal(h.entries.at(-1)?.outcome, "notification-unmatched");
});

test("文言が未知の Notification は監査に残す", async () => {
  const h = makeHarness();
  const outcome = await h.runtime.handleNotification("Totally new wording");
  assert.equal(outcome.kind, "unknown");
  assert.equal(h.posted.length, 0);
  assert.equal(h.entries.at(-1)?.outcome, "notification-unknown");
});

test("回答は TUI へ打鍵で届く (allow は選択位置を動かさない)", async () => {
  const h = makeHarness();
  h.runtime.observeCheck({ tool_name: "Bash", tool_input: { command: "ls" }, permission_mode: "auto" });
  const posted = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  const requestId = posted.requestId as string;

  const answered = h.runtime.answer(requestId, "allow");
  assert.equal(answered.handled, true);
  assert.deepEqual(h.keys, ["\r"]);
  assert.equal(h.entries.at(-1)?.outcome, "answered-remote");

  // 二重回答しない (待ち行列から外れている)。
  assert.equal(h.runtime.answer(requestId, "allow").handled, false);
  assert.equal(h.keys.length, 1);
});

test("deny は ESC、 ask は打鍵しない", async () => {
  const h = makeHarness();
  const first = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  h.runtime.answer(first.requestId as string, "deny");
  assert.deepEqual(h.keys, ["\x1b"]);

  const second = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  h.runtime.answer(second.requestId as string, "ask");
  assert.equal(h.keys.length, 1, "ask は人間が TUI で決める — 打鍵しない");
});

test("dispose 後の回答は pty へ届かない", async () => {
  const h = makeHarness();
  const posted = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  h.runtime.dispose();
  assert.equal(h.runtime.answer(posted.requestId as string, "allow").handled, false);
  assert.equal(h.keys.length, 0);
});

test("期限切れの Notification 回答は TUI へ注入しない", async () => {
  let now = 1_000;
  const h = makeHarness({}, { now: () => now });
  const posted = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  now += 600_000;

  assert.equal(h.runtime.answer(posted.requestId as string, "allow").handled, false);
  assert.equal(h.keys.length, 0);
});

test("注入時計は既定の観測バッファにも適用される", async () => {
  let now = 1_000;
  const h = makeHarness({}, { now: () => now });
  h.runtime.observeCheck({ tool_name: "Bash", tool_input: { command: "ls" } });
  now += 1;

  const posted = await h.runtime.handleNotification("Claude needs your permission to use Bash");

  assert.equal(posted.matched, true);
  assert.deepEqual(h.posted[0].tool_input, { command: "ls" });
  assert.equal(h.entries[0].ts, new Date(1_000).toISOString());
});

test("Concordia 不達でも許可経路は落ちない", async () => {
  const h = makeHarness({
    concordia: {
      permissionRequest: async () => {
        throw new Error("coordinator down");
      },
    },
  });
  const outcome = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  assert.equal(outcome.posted, false);
  assert.equal(h.entries.at(-1)?.outcome, "post-failed");
});

test("非 auto mode でも Notification が来るまでカードは出ない", async () => {
  const h = makeHarness();
  h.runtime.observeCheck({
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    permission_mode: "acceptEdits",
  });
  assert.equal(h.posted.length, 0);

  const outcome = await h.runtime.handleNotification("Claude needs your permission to use Bash");
  assert.equal(outcome.posted, true);
  assert.deepEqual(h.posted[0].tool_input, { command: "npm test" });
});
