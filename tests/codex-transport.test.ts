import test from "node:test";
import assert from "node:assert/strict";
import { codexTransport, resolveCodexTransport } from "../src/wrap.js";

test("codexTransport defaults to app-server and validates explicit values", () => {
  assert.equal(codexTransport({}), "app-server");
  assert.equal(codexTransport({ LICTOR_CODEX_TRANSPORT: "legacy" }), "legacy");
  assert.throws(
    () => codexTransport({ LICTOR_CODEX_TRANSPORT: "automatic" }),
    /invalid LICTOR_CODEX_TRANSPORT/,
  );
});

test("resolveCodexTransport: 対話 (delegation なし) は legacy に落ちる", () => {
  // codex 0.144.x はターン 0 の rollout を書かないため、対話の
  // bind→resume は "No saved session found" で即死する (2026-07-13 実測)。
  assert.equal(resolveCodexTransport({}, false), "legacy");
});

test("resolveCodexTransport: headless delegation は app-server を維持", () => {
  assert.equal(resolveCodexTransport({}, true), "app-server");
});

test("resolveCodexTransport: env 明示指定は対話でも尊重する", () => {
  assert.equal(resolveCodexTransport({ LICTOR_CODEX_TRANSPORT: "app-server" }, false), "app-server");
  assert.equal(resolveCodexTransport({ LICTOR_CODEX_TRANSPORT: "legacy" }, true), "legacy");
});
