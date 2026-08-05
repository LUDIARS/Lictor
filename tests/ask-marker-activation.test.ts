import { test } from "node:test";
import assert from "node:assert/strict";
import { planAskMarkerActivation } from "../src/ask-marker-activation.js";

// @implements SPEC-ASK-MARKER-ACTIVATION

test("planAskMarkerActivation: Codex detection does not require a session injector", () => {
  assert.deepEqual(planAskMarkerActivation("codex", true, false), {
    enabled: true,
    injection: "none",
    reason: "codex-external-steering",
  });
});

test("planAskMarkerActivation: Codex detection requires Concordia", () => {
  assert.deepEqual(planAskMarkerActivation("codex", false, false), {
    enabled: false,
    injection: "none",
    reason: "concordia-disabled",
  });
});

test("planAskMarkerActivation: Claude uses session system-prompt injection", () => {
  assert.deepEqual(planAskMarkerActivation("claude", true, true), {
    enabled: true,
    injection: "claude-system-prompt",
    reason: "claude-system-prompt",
  });
});

test("planAskMarkerActivation: Claude reports a missing session injector", () => {
  assert.deepEqual(planAskMarkerActivation("claude", true, false), {
    enabled: false,
    injection: "none",
    reason: "session-injector-missing",
  });
});

test("planAskMarkerActivation: unsupported providers stay disabled", () => {
  assert.deepEqual(planAskMarkerActivation("gemini", true, false), {
    enabled: false,
    injection: "none",
    reason: "provider-unsupported",
  });
});
