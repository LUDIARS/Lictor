import { test } from "node:test";
import assert from "node:assert/strict";
import { providerRuntimeMetadata } from "../src/provider-runtime-metadata.js";

test("providerRuntimeMetadata reads separate Claude model and effort values", () => {
  assert.deepEqual(
    providerRuntimeMetadata("claude", [
      "--model",
      "claude-fable-5",
      "--effort",
      "xhigh",
    ]),
    {
      model: "claude-fable-5",
      effort: "xhigh",
    },
  );
});

test("providerRuntimeMetadata reads equals-form Claude options", () => {
  assert.deepEqual(
    providerRuntimeMetadata("claude", [
      "--model=claude-sonnet-5",
      "--effort=medium",
    ]),
    {
      model: "claude-sonnet-5",
      effort: "medium",
    },
  );
});

test("providerRuntimeMetadata preserves the last explicit nonempty value", () => {
  assert.deepEqual(
    providerRuntimeMetadata("claude", [
      "--model=claude-opus-4-8",
      "--model=",
      "--model",
      "claude-fable-5",
      "--effort",
      "--verbose",
      "--effort=xhigh",
    ]),
    {
      model: "claude-fable-5",
      effort: "xhigh",
    },
  );
});

test("providerRuntimeMetadata ignores options after the argument delimiter", () => {
  assert.deepEqual(
    providerRuntimeMetadata("claude", [
      "--model",
      "claude-fable-5",
      "--",
      "--effort=xhigh",
    ]),
    {
      model: "claude-fable-5",
    },
  );
});

test("providerRuntimeMetadata does not infer runtime metadata for other providers", () => {
  assert.deepEqual(
    providerRuntimeMetadata("codex", [
      "--model",
      "gpt-5.6-sol",
      "--effort",
      "xhigh",
    ]),
    {},
  );
});
