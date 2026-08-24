import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNodePtySpawnHelperExecutable } from "../scripts/ensure-node-pty-helper.mjs";

test("macOS node-pty spawn-helper の実行権限を自己修復する", {
  skip: process.platform === "win32" ? "Windows does not expose POSIX executable bits" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-node-pty-"));
  try {
    const helperDir = join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64");
    mkdirSync(helperDir, { recursive: true });
    const helper = join(helperDir, "spawn-helper");
    writeFileSync(helper, "");
    chmodSync(helper, 0o644);

    assert.equal(ensureNodePtySpawnHelperExecutable({ platform: "darwin", arch: "arm64", root }), true);
    assert.notEqual(statSync(helper).mode & 0o111, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS 以外では node-pty spawn-helper を変更しない", () => {
  assert.equal(ensureNodePtySpawnHelperExecutable({ platform: "linux", arch: "arm64", root: "/missing" }), false);
});
