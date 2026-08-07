import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readRepoOrigin, withRepoOrigin } from "../src/repo-origin.js";

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function createRepository(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  runGit(cwd, ["init"]);
  return cwd;
}

test("readRepoOrigin returns the configured URL from a git repository", () => {
  const cwd = createRepository("lictor-repo-origin-");
  try {
    runGit(cwd, ["remote", "add", "origin", "git@github.com:LUDIARS/Lictor.git"]);
    assert.equal(readRepoOrigin(cwd), "git@github.com:LUDIARS/Lictor.git");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readRepoOrigin returns null for no remote, non-git paths, and git failures", () => {
  const repository = createRepository("lictor-repo-origin-no-remote-");
  const nonGitDirectory = mkdtempSync(join(tmpdir(), "lictor-repo-origin-non-git-"));
  try {
    assert.equal(readRepoOrigin(repository), null);
    assert.equal(readRepoOrigin(nonGitDirectory), null);
    assert.equal(readRepoOrigin(repository, () => {
      throw new Error("git unavailable");
    }), null);
    assert.equal(readRepoOrigin(repository, () => "   \n"), null);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(nonGitDirectory, { recursive: true, force: true });
  }
});

test("readRepoOrigin redacts HTTP(S) credentials", () => {
  assert.equal(
    readRepoOrigin("unused", () => "https://token:secret@part@example.test/LUDIARS/Lictor.git\n"),
    "https://example.test/LUDIARS/Lictor.git",
  );
  assert.equal(
    readRepoOrigin("unused", () => "https://token@example.test/LUDIARS/Lictor.git"),
    "https://example.test/LUDIARS/Lictor.git",
  );
});

test("readRepoOrigin resolves the parent repository origin from a linked worktree", () => {
  const repository = createRepository("lictor-repo-origin-worktree-");
  const worktree = `${repository}-worktree`;
  try {
    runGit(repository, ["remote", "add", "origin", "https://github.com/LUDIARS/Lictor.git"]);
    runGit(repository, ["config", "user.email", "test@example.com"]);
    runGit(repository, ["config", "user.name", "Lictor test"]);
    runGit(repository, ["commit", "--allow-empty", "-m", "initial"]);
    runGit(repository, ["worktree", "add", "-b", "repo-origin-test", worktree]);

    assert.equal(readRepoOrigin(worktree), "https://github.com/LUDIARS/Lictor.git");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("registration and active-repo patch payloads include repo_origin", () => {
  const cwd = createRepository("lictor-repo-origin-payload-");
  try {
    runGit(cwd, ["remote", "add", "origin", "https://example.test/LUDIARS/Lictor.git"]);

    const registration = withRepoOrigin({
      id: "lictor-test",
      provider: "codex",
      repo_path: cwd,
      host: "test-host",
    });
    const activeRepoPatch = withRepoOrigin({ repo_path: cwd });

    assert.equal(registration.repo_origin, "https://example.test/LUDIARS/Lictor.git");
    assert.equal(activeRepoPatch.repo_origin, "https://example.test/LUDIARS/Lictor.git");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
