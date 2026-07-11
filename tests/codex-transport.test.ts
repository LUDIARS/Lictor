import test from "node:test";
import assert from "node:assert/strict";
import { codexTransport } from "../src/wrap.js";

test("codexTransport defaults to app-server and validates explicit values", () => {
  assert.equal(codexTransport({}), "app-server");
  assert.equal(codexTransport({ LICTOR_CODEX_TRANSPORT: "legacy" }), "legacy");
  assert.throws(
    () => codexTransport({ LICTOR_CODEX_TRANSPORT: "automatic" }),
    /invalid LICTOR_CODEX_TRANSPORT/,
  );
});
