import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNotification } from "../src/permission-notify.js";
import { PermissionPendingBuffer } from "../src/permission-pending.js";
import { buildPermissionAnswerSequence, toPermissionAnswer } from "../src/permission-answer.js";

test("classifyNotification: 許可要求だけを permission と見なす", () => {
  const permission = classifyNotification("Claude needs your permission to use Bash");
  assert.equal(permission.kind, "permission");
  assert.equal(permission.toolName, "Bash");

  // 60s 無操作の催促は許可要求ではない (カードを出してはいけない)。
  assert.equal(classifyNotification("Claude is waiting for your input").kind, "idle");
  // 文言不明は unknown。 監査ログに残して文言変更に気づけるようにする。
  assert.equal(classifyNotification("Something else entirely").kind, "unknown");
  assert.equal(classifyNotification(undefined).kind, "unknown");
});

test("classifyNotification: mcp ツール名も読み取る", () => {
  const c = classifyNotification("Claude needs your permission to use mcp__excubitor__excubitor_ports");
  assert.equal(c.kind, "permission");
  assert.equal(c.toolName, "mcp__excubitor__excubitor_ports");
});

test("PermissionPendingBuffer: ツール名一致で最新の観測を取り出す", () => {
  let now = 1000;
  const buffer = new PermissionPendingBuffer({ now: () => now, ttlMs: 500 });
  buffer.record({ requestId: "a", toolName: "Bash", toolInput: { command: "git status" }, permissionMode: "auto" });
  buffer.record({ requestId: "b", toolName: "Write", toolInput: { file_path: "x.ts" }, permissionMode: "auto" });
  buffer.record({ requestId: "c", toolName: "Bash", toolInput: { command: "rm -rf /" }, permissionMode: "auto" });

  const taken = buffer.take("Bash");
  assert.equal(taken?.requestId, "c");
  // 取り出したものは消える (同じ観測で 2 枚カードを出さない)。
  assert.equal(buffer.take("Bash")?.requestId, "a");
  assert.equal(buffer.size, 1);
});

test("PermissionPendingBuffer: ツール名不明なら最新を返す / TTL 切れは返さない", () => {
  let now = 1000;
  const buffer = new PermissionPendingBuffer({ now: () => now, ttlMs: 500 });
  buffer.record({ requestId: "a", toolName: "Bash", toolInput: null, permissionMode: "auto" });
  assert.equal(buffer.take(null)?.requestId, "a");

  buffer.record({ requestId: "b", toolName: "Bash", toolInput: null, permissionMode: "auto" });
  now += 5000;
  assert.equal(buffer.take("Bash"), null);
  assert.equal(buffer.size, 0);
});

test("PermissionPendingBuffer: maxEntries を超えたら古いものから捨てる", () => {
  const buffer = new PermissionPendingBuffer({ maxEntries: 2 });
  buffer.record({ requestId: "a", toolName: "Bash", toolInput: null, permissionMode: null });
  buffer.record({ requestId: "b", toolName: "Bash", toolInput: null, permissionMode: null });
  buffer.record({ requestId: "c", toolName: "Bash", toolInput: null, permissionMode: null });
  assert.equal(buffer.size, 2);
  assert.equal(buffer.take("Bash")?.requestId, "c");
  assert.equal(buffer.take("Bash")?.requestId, "b");
});

test("buildPermissionAnswerSequence: allow は選択位置を動かさない", () => {
  assert.equal(buildPermissionAnswerSequence("allow"), "\r");
  assert.equal(buildPermissionAnswerSequence("deny"), "\x1b");
});

test("toPermissionAnswer: ask は注入しない", () => {
  assert.equal(toPermissionAnswer("allow"), "allow");
  assert.equal(toPermissionAnswer("deny"), "deny");
  assert.equal(toPermissionAnswer("allow_always"), null);
  assert.equal(toPermissionAnswer("ask"), null);
  assert.equal(toPermissionAnswer("whatever"), null);
});
