import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPermissionRequest } from "../src/permission-classify.js";

test("classifyPermissionRequest: auto mode and harmless tool are self-processable", () => {
  assert.equal(
    classifyPermissionRequest({ permission_mode: "acceptEdits", tool_name: "Read" }),
    "self-processable",
  );
  assert.equal(
    classifyPermissionRequest({ permission_mode: "bypassPermissions", tool_name: "Grep", guard_result: "allow" }),
    "self-processable",
  );
});

test("classifyPermissionRequest: guard rejection always requires user confirmation", () => {
  assert.equal(
    classifyPermissionRequest({
      permission_mode: "bypassPermissions",
      tool_name: "Read",
      guard_result: { decision: "deny" },
    }),
    "user-confirmation",
  );
});

test("classifyPermissionRequest: unknown inputs require user confirmation", () => {
  assert.equal(classifyPermissionRequest({ permission_mode: "future-mode", tool_name: "Read" }), "user-confirmation");
  assert.equal(classifyPermissionRequest({ permission_mode: "acceptEdits", tool_name: "Bash" }), "user-confirmation");
  assert.equal(classifyPermissionRequest({ permission_mode: "acceptEdits", tool_name: "Read", guard_result: {} }), "user-confirmation");
});
