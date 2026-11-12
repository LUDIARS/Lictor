import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseTaskSetArgs } from "../src/task-set-args.js";
import { relayWorkingTarget } from "../src/working-target-relay.js";

/**
 * 2026-11-12: Cc の task-branch ゲートが拒否文で案内する
 * `lictor cli task set --repo "<checkout>" --branch <b> --desc "作業内容"` を Lictor が
 * `unexpected arg '--repo'` で拒否し、案内に従っても復旧できなかった。
 */
test("parses the registration command the Cc gate suggests", () => {
  // Cc registrationCommand の出力をシェルが語に分けたもの。
  const words = ["--repo", "E:/Document/Ars/.wt-Castra-raw-network", "--branch", "fix/harness-raw-network-script", "--desc", "作業内容"];
  const parsed = parseTaskSetArgs(words, "C:/elsewhere");
  assert.deepEqual(parsed, { ok: true, payload: {
    repo: resolve("E:/Document/Ars/.wt-Castra-raw-network"), branch: "fix/harness-raw-network-script", desc: "作業内容" } });
});

test("resolves a relative --repo against the caller's cwd", () => {
  const parsed = parseTaskSetArgs(["--repo", "game", "--branch", "dev"], resolve("fixture/castra"));
  assert.deepEqual(parsed, { ok: true, payload: { repo: resolve("fixture/castra/game"), branch: "dev" } });
});

test("keeps the existing --branch / --desc forms and rejects unknown args", () => {
  assert.deepEqual(parseTaskSetArgs(["--branch", "main", "--desc", "a", "b"], "."), { ok: true, payload: { branch: "main", desc: "a b" } });
  assert.equal(parseTaskSetArgs(["--bogus", "x"], ".").ok, false);
  assert.equal(parseTaskSetArgs([], ".").ok, false);
  // --repo は branch が無いと登録にならない。
  assert.equal(parseTaskSetArgs(["--repo", "/x", "--desc", "a"], ".").ok, false);
});

test("relays --repo as an added working target and reports failures", async () => {
  const calls: Array<{ id: string; target: { repo: string; branch: string } }> = [];
  const client = { addWorkingTarget: async (id: string, target: { repo: string; branch: string }) => {
    calls.push({ id, target });
    return { ok: true, registration: { working_targets: [target] } };
  } };
  const repo = resolve("fixture/wt");
  const added = await relayWorkingTarget({ client, sessionId: "s1", repo, branch: "fix/x" });
  assert.deepEqual(added, { ok: true, registration: { working_targets: [{ repo, branch: "fix/x" }] } });
  assert.deepEqual(calls, [{ id: "s1", target: { repo, branch: "fix/x" } }]);

  assert.equal((await relayWorkingTarget({ client, sessionId: "s1", repo: "relative", branch: "b" })).ok, false);
  assert.equal((await relayWorkingTarget({ client, sessionId: "s1", repo, branch: undefined })).ok, false);
  assert.deepEqual(await relayWorkingTarget({ client: null, sessionId: "s1", repo, branch: "b" }),
    { ok: false, status: 503, error: "Concordia session is not bound" });
  const failing = { addWorkingTarget: async () => { throw new Error("HTTP 400"); } };
  assert.deepEqual(await relayWorkingTarget({ client: failing, sessionId: "s1", repo, branch: "b" }),
    { ok: false, status: 502, error: "HTTP 400" });
});
