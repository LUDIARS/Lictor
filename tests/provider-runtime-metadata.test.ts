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

test("providerRuntimeMetadata reads Codex model values", () => {
  assert.deepEqual(
    providerRuntimeMetadata("codex", [
      "--model",
      "gpt-5.6-sol",
      "--effort",
      "xhigh",
    ]),
    {
      model: "gpt-5.6-sol",
    },
  );
});

test("providerRuntimeMetadata reads Codex reasoning effort from config", () => {
  assert.deepEqual(
    providerRuntimeMetadata("codex", [
      "--model=gpt-5.6-sol",
      "-c",
      'model_reasoning_effort = "xhigh"',
      "--config=model_reasoning_effort=high",
    ]),
    {
      model: "gpt-5.6-sol",
      effort: "high",
    },
  );
});

test("providerRuntimeMetadata ignores runtime metadata for other providers", () => {
  assert.deepEqual(
    providerRuntimeMetadata("other", ["--model", "untrusted", "--effort=high"]),
    {},
  );
});
