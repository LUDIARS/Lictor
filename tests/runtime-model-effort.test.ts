import assert from "node:assert/strict";
import test from "node:test";
import { applyRuntimeModelEffort } from "../src/runtime-model-effort.js";

test("Codex rejects catalog-order-dependent remote picker automation", async () => {
  const writes: string[] = [];
  const result = await applyRuntimeModelEffort({
    provider: "codex",
    request: { model: "gpt-5.6-terra", effort: "medium" },
    write: (value) => writes.push(value),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.deepEqual(writes, []);
});

test("Claude receives exact provider-native model and effort commands", async () => {
  const writes: string[] = [];
  const result = await applyRuntimeModelEffort({
    provider: "claude",
    request: { model: "sonnet", effort: "medium" },
    write: (value) => writes.push(value),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(writes, ["/model sonnet\r", "/effort medium\r"]);
});

test("Claude runtime switches do not interleave on the same PTY", async () => {
  const writes: string[] = [];
  const write = (value: string) => writes.push(value);

  const first = applyRuntimeModelEffort({
    provider: "claude",
    request: { model: "sonnet", effort: "medium" },
    write,
  });
  const second = applyRuntimeModelEffort({
    provider: "claude",
    request: { model: "opus", effort: "high" },
    write,
  });

  await Promise.all([first, second]);
  assert.deepEqual(writes, [
    "/model sonnet\r",
    "/effort medium\r",
    "/model opus\r",
    "/effort high\r",
  ]);
});
