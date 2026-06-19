import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLictorHookSettings, resolveHarnessGuard } from "../src/harness-hook.js";

test("resolveHarnessGuard: env 未設定なら null", () => {
  assert.equal(resolveHarnessGuard({}), null);
});

test("resolveHarnessGuard: 指すファイルが無ければ null", () => {
  assert.equal(
    resolveHarnessGuard({ LICTOR_HARNESS_GUARD: join(tmpdir(), "no-such-harness-guard.mjs") }),
    null,
  );
});

test("resolveHarnessGuard: 実在ファイルならそのパス", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-hg-"));
  const f = join(dir, "harness-guard.mjs");
  writeFileSync(f, "// stub\n", "utf8");
  try {
    assert.equal(resolveHarnessGuard({ LICTOR_HARNESS_GUARD: f }), f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
