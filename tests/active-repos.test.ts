import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeReposPath,
  pickActiveRepo,
  readActiveRepos,
  resolveActiveReposDir,
} from "../src/active-repos.js";

test("resolveActiveReposDir prefers LICTOR_ACTIVE_REPOS_DIR", () => {
  const dir = resolveActiveReposDir({ LICTOR_ACTIVE_REPOS_DIR: "C:/custom/state" } as NodeJS.ProcessEnv);
  assert.equal(dir, "C:/custom/state");
});

test("resolveActiveReposDir falls back to CLAUDE_PROJECT_DIR/.claude/state", () => {
  const dir = resolveActiveReposDir({
    CLAUDE_PROJECT_DIR: "E:/Document/Ars",
  } as NodeJS.ProcessEnv);
  // path.join はプラットフォーム依存セパレータを使うので endsWith で判定.
  assert.ok(dir.endsWith(".claude/state") || dir.endsWith(".claude\\state"), `unexpected: ${dir}`);
  assert.ok(dir.startsWith("E:"), `unexpected: ${dir}`);
});

test("resolveActiveReposDir hardcoded fallback when env empty", () => {
  const dir = resolveActiveReposDir({} as NodeJS.ProcessEnv);
  assert.ok(dir.includes(".claude"));
});

test("activeReposPath composes <dir>/active-repos-<sid>.txt", () => {
  const p = activeReposPath("/state", "abcd-1234");
  assert.ok(p.endsWith("active-repos-abcd-1234.txt"), p);
});

test("readActiveRepos returns empty for missing file", () => {
  assert.deepEqual(readActiveRepos("/nonexistent/path-xyz-12345.txt"), []);
});

test("readActiveRepos preserves order + dedups + skips blanks", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-active-repos-"));
  try {
    const file = join(dir, "active-repos-test.txt");
    writeFileSync(
      file,
      [
        "E:/Document/Ars/Lictor",
        "",
        "E:/Document/Ars/Concordia",
        "E:/Document/Ars/Lictor", // dup
        "  ",
        "E:/Document/Ars/Memoria",
      ].join("\n"),
      "utf8",
    );
    const out = readActiveRepos(file);
    assert.deepEqual(out, [
      "E:/Document/Ars/Lictor",
      "E:/Document/Ars/Concordia",
      "E:/Document/Ars/Memoria",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveRepos handles CRLF line endings (Windows-written files)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-active-repos-"));
  try {
    const file = join(dir, "active-repos-crlf.txt");
    writeFileSync(file, "E:/a\r\nE:/b\r\n", "utf8");
    assert.deepEqual(readActiveRepos(file), ["E:/a", "E:/b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickActiveRepo returns last entry when list non-empty", () => {
  assert.equal(pickActiveRepo(["a", "b", "c"], "/fallback"), "c");
});

test("pickActiveRepo returns fallback when list empty", () => {
  assert.equal(pickActiveRepo([], "/fallback"), "/fallback");
});
