// hook から Lictor 自身を絶対パスで呼ぶ (PATH に lictor が無い拠点で SessionStart hook が
// exit 127 になり、 transcript が束縛されず返答がどこにも届かなかった: MELPOT 2026-10-12)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLictorHookSettings } from "../src/harness-hook.js";
import { buildLictorCommand, currentLictorCommand, quoteForHookShell, resolveLictorBin } from "../src/lictor-command.js";

test("buildLictorCommand: node と bin を / 区切りの引用付き絶対パスで並べる", () => {
  assert.equal(
    buildLictorCommand("C:\\Program Files\\nodejs\\node.exe", "D:\\LUDIARS\\Lictor\\bin\\lictor.mjs"),
    '"C:/Program Files/nodejs/node.exe" "D:/LUDIARS/Lictor/bin/lictor.mjs"',
  );
  assert.equal(buildLictorCommand("/usr/local/bin/node", "/opt/lictor/bin/lictor.mjs"), '"/usr/local/bin/node" "/opt/lictor/bin/lictor.mjs"');
});

test("buildLictorCommand: bin が分からなければ従来の lictor に戻す", () => {
  assert.equal(buildLictorCommand("/usr/bin/node", null), "lictor");
  assert.equal(buildLictorCommand("", "/opt/lictor/bin/lictor.mjs"), "lictor");
});

test("quoteForHookShell: 二重引用符を escape する", () => {
  assert.equal(quoteForHookShell('a"b'), '"a\\"b"');
});

test("resolveLictorBin: このリポの bin/lictor.mjs を見つけ、 無い場所では null", () => {
  const bin = resolveLictorBin();
  assert.ok(bin && existsSync(bin) && /bin[\\/]lictor\.mjs$/.test(bin));
  assert.equal(resolveLictorBin(pathToFileURL(join(tmpdir(), "nonexistent-lictor-root", "dist", "lictor-command.js")).href), null);
  assert.equal(resolveLictorBin("not a url"), null);
});

test("currentLictorCommand: 実行中の node と bin を指し、 素の lictor に頼らない", () => {
  const command = currentLictorCommand();
  assert.ok(command.startsWith(quoteForHookShell(process.execPath)));
  assert.match(command, /bin\/lictor\.mjs"$/);
});

test("buildLictorHookSettings: 全 hook が渡した前置きで Lictor を呼ぶ", () => {
  const prefix = '"C:/node.exe" "D:/LUDIARS/Lictor/bin/lictor.mjs"';
  const s = buildLictorHookSettings(null, "D:\\LUDIARS\\.claude\\state", prefix);
  const commands = [
    ...s.hooks.PreToolUse, ...s.hooks.PostToolUse, ...s.hooks.SessionStart, ...s.hooks.Notification,
  ].flatMap((m) => m.hooks.map((h) => h.command));
  assert.equal(commands.length, 5);
  for (const command of commands) assert.ok(command.startsWith(`${prefix} cli `), command);
  assert.ok(commands.some((command) => command.startsWith(`${prefix} cli session-id-hook --state-dir-b64 `)));
});
