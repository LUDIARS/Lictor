import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTaskSetArgs, TASK_SET_USAGE } from "../src/task-set-args.js";
import { gitCheckoutProbe, resolveTaskSetRepo, type CheckoutProbe } from "../src/task-set-repo.js";

/**
 * 2026-11-16: Cc ゲートの案内どおり `lictor cli task set --repo ... --branch ... --desc ...` を打てるよう、
 * --help / 未知引数で usage を出し、--repo の存在・checkout を CLI 側で検査し、--branch 省略時は現在 branch を使う。
 */
function probe(dirs: Record<string, string | null>): CheckoutProbe {
  return {
    isDirectory: (p) => p in dirs,
    currentBranch: (p) => dirs[p] ?? null,
  };
}

test("--help returns usage that documents --repo and the --desc ordering", () => {
  const parsed = parseTaskSetArgs(["--help"], ".");
  assert.deepEqual(parsed, { ok: false, help: true, usage: TASK_SET_USAGE });
  assert.match(TASK_SET_USAGE, /--repo <checkout>/);
  assert.match(TASK_SET_USAGE, /before it/);
  assert.equal((parseTaskSetArgs(["--repo", "/x", "-h"], ".") as { help?: boolean }).help, true);
  // --desc の後ろの --help は説明文の一部。
  assert.deepEqual(parseTaskSetArgs(["--branch", "b", "--desc", "see", "--help"], "."),
    { ok: true, payload: { branch: "b", desc: "see --help" } });
});

test("unknown args are rejected with the usage", () => {
  const parsed = parseTaskSetArgs(["--bogus", "x"], ".");
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && !parsed.help && parsed.error.includes("unexpected arg '--bogus'") && parsed.error.includes(TASK_SET_USAGE));
});

test("resolveTaskSetRepo keeps a given --branch and fills the current branch when omitted", () => {
  const repo = resolve("fixture/wt");
  const p = probe({ [repo]: "feat/current" });
  assert.deepEqual(resolveTaskSetRepo({ repo, branch: "fix/b", desc: "x" }, p), { ok: true, payload: { repo, branch: "fix/b", desc: "x" } });
  assert.deepEqual(resolveTaskSetRepo({ repo, desc: "x" }, p), { ok: true, payload: { repo, branch: "feat/current", desc: "x" } });
});

test("resolveTaskSetRepo rejects missing paths, non-checkouts and detached HEAD without --branch", () => {
  const repo = resolve("fixture/wt");
  assert.match((resolveTaskSetRepo({ repo, branch: "b" }, probe({})) as { error: string }).error, /does not exist/);
  assert.match((resolveTaskSetRepo({ repo, branch: "b" }, probe({ [repo]: null })) as { error: string }).error, /not a git checkout/);
  assert.match((resolveTaskSetRepo({ repo }, probe({ [repo]: "HEAD" })) as { error: string }).error, /detached/);
  assert.deepEqual(resolveTaskSetRepo({ repo, branch: "b" }, probe({ [repo]: "HEAD" })), { ok: true, payload: { repo, branch: "b" } });
});

test("payloads without --repo pass through unchanged", () => {
  const payload = { branch: "main", desc: "a" };
  assert.deepEqual(resolveTaskSetRepo(payload, probe({})), { ok: true, payload });
});

test("gitCheckoutProbe distinguishes a checkout, a plain directory and a missing path", () => {
  const plain = mkdtempSync(join(tmpdir(), "lictor-task-set-"));
  try {
    assert.equal(gitCheckoutProbe.isDirectory(join(plain, "missing")), false);
    assert.equal(gitCheckoutProbe.isDirectory(plain), true);
    assert.equal(gitCheckoutProbe.currentBranch(plain), null);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
  const here = resolve(".");
  assert.equal(typeof gitCheckoutProbe.currentBranch(here), "string");
});
