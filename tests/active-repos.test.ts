import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeReposPath,
  claudeSessionStatePath,
  pickActiveRepo,
  readActiveRepos,
  readClaudeSessionId,
  resolveActiveReposDir,
} from "../src/active-repos.js";

test("claudeSessionStatePath: lictor id ごとの追跡ファイル名", () => {
  const p = claudeSessionStatePath("C:/state", "lictor-abc");
  assert.equal(p, join("C:/state", "claude-session-lictor-abc.txt"));
});

test("readClaudeSessionId: 書いた sid を読み戻す / 無ければ null", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-csid-"));
  try {
    const p = claudeSessionStatePath(dir, "lictor-xyz");
    assert.equal(readClaudeSessionId(p), null); // 未作成
    writeFileSync(p, "  79408afa-6e3a-4d1f-84d0-4916670dd84f  \n", "utf8");
    assert.equal(readClaudeSessionId(p), "79408afa-6e3a-4d1f-84d0-4916670dd84f"); // trim 済
    writeFileSync(p, "   \n", "utf8");
    assert.equal(readClaudeSessionId(p), null); // 空白のみは null
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
