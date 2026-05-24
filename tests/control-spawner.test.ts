import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWtArgs, validateCwd } from "../src/control/spawner.js";

test("buildWtArgs: default tab mode", () => {
  const args = buildWtArgs({ provider: "claude" });
  assert.deepEqual(args, ["--window", "0", "new-tab", "cmd.exe", "/d", "/s", "/c", "lictor", "claude"]);
});

test("buildWtArgs: window mode", () => {
  const args = buildWtArgs({ provider: "codex", mode: "window" });
  assert.deepEqual(args, ["--window", "new", "new-tab", "cmd.exe", "/d", "/s", "/c", "lictor", "codex"]);
});

test("buildWtArgs: with title + cwd + provider args", () => {
  const args = buildWtArgs({
    provider: "claude",
    title: "[Cr] auth fix",
    cwd: "E:\\Document\\Ars\\Cernere",
    args: ["--continue", "--model", "opus"],
  });
  assert.deepEqual(args, [
    "--window",
    "0",
    "new-tab",
    "--title",
    "[Cr] auth fix",
    "-d",
    "E:\\Document\\Ars\\Cernere",
    "cmd.exe",
    "/d",
    "/s",
    "/c",
    "lictor",
    "claude",
    "--continue",
    "--model",
    "opus",
  ]);
});

test("validateCwd: accepts existing dir", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lictor-cwd-"));
  assert.equal(validateCwd(tmp), null);
  rmSync(tmp, { recursive: true, force: true });
});

test("validateCwd: undefined is OK", () => {
  assert.equal(validateCwd(undefined), null);
});

test("validateCwd: missing dir errors", () => {
  const fake = join(tmpdir(), "lictor-nope-" + Date.now());
  assert.match(validateCwd(fake) ?? "", /does not exist/);
});
