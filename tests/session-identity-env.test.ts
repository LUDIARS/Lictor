import { test } from "node:test";
import assert from "node:assert/strict";
import { pinSessionIdentityEnv, SESSION_IDENTITY_ENV_KEYS } from "../src/session-identity-env.js";

// Reproduces 2026-11-16: a Lictor launched from another Lictor session's env
// (same cwd) while Concordia was restarting kept the inherited session id, so
// its wrapped claude acted as — and received injects for — the other session.
const INHERITED: NodeJS.ProcessEnv = {
  LICTOR_SESSION_ID: "lictor-9f9a75a2",
  CONCORDIA_SESSION_ID: "lictor-9f9a75a2",
  LICTOR_PORT: "50000",
  PATH: "/usr/bin",
};

test("pinSessionIdentityEnv: Concordia 未登録なら継承した別セッションの id を名乗らない", () => {
  const out = pinSessionIdentityEnv(INHERITED, null);
  for (const key of SESSION_IDENTITY_ENV_KEYS) assert.equal(key in out, false, key);
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.LICTOR_PORT, "50000");
});

test("pinSessionIdentityEnv: 登録済みなら継承値ではなく自プロセスの id に固定する", () => {
  const out = pinSessionIdentityEnv(INHERITED, "lictor-87a363c0");
  assert.equal(out.LICTOR_SESSION_ID, "lictor-87a363c0");
  assert.equal(out.CONCORDIA_SESSION_ID, "lictor-87a363c0");
});

test("pinSessionIdentityEnv: 入力 env を変更しない", () => {
  const input = { ...INHERITED };
  pinSessionIdentityEnv(input, null);
  assert.deepEqual(input, INHERITED);
});
