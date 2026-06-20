import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLictorHookSettings, resolveHarnessGuard } from "../src/harness-hook.js";

test("resolveHarnessGuard: .claude/hooks/harness-guard.mjs が無ければ null", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-hg-"));
  try {
    assert.equal(resolveHarnessGuard(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHarnessGuard: 上位の .claude/hooks/harness-guard.mjs を辿って見つける", () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-ws-"));
  const guard = join(root, ".claude", "hooks", "harness-guard.mjs");
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  writeFileSync(guard, "// stub\n", "utf8");
  const deep = join(root, "SomeRepo", "src");
  mkdirSync(deep, { recursive: true });
  try {
    // ワークスペース直下に置いた guard を、配下の repo/src からでも解決する
    assert.equal(resolveHarnessGuard(deep), guard);
    assert.equal(resolveHarnessGuard(root), guard);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildLictorHookSettings: guard 無しは既定 2 フックのみ", () => {
  const s = buildLictorHookSettings(null);
  const pre = s.hooks.PreToolUse;
  assert.equal(pre.length, 2);
  assert.ok(!pre.some((m) => m.matcher === "Bash"));
});

test("buildLictorHookSettings: guard ありは PreToolUse(Bash) を追加", () => {
  const s = buildLictorHookSettings("E:\\Document\\Ars\\.claude\\hooks\\harness-guard.mjs");
  const pre = s.hooks.PreToolUse;
  assert.equal(pre.length, 3);
  const guard = pre[pre.length - 1];
  assert.equal(guard.matcher, "Bash");
  // backslash は forward-slash に正規化し quote して node に渡す
  assert.equal(
    guard.hooks[0].command,
    'node "E:/Document/Ars/.claude/hooks/harness-guard.mjs"',
  );
  // 既定の permission-hook / ask-question-hook は保持
  assert.ok(pre.some((m) => m.hooks[0].command === "lictor cli permission-hook"));
  assert.ok(pre.some((m) => m.hooks[0].command === "lictor cli ask-question-hook"));
});
