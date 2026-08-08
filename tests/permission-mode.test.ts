import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldProxyPermissionRequest } from "../src/permission-hook.js";
import { usesClaudeNativeAutoPermissions } from "../src/permission-mode.js";

test("usesClaudeNativeAutoPermissions recognises only Claude's current auto mode", () => {
  assert.equal(usesClaudeNativeAutoPermissions("auto"), true);
  assert.equal(usesClaudeNativeAutoPermissions(" AUTO "), true);
  assert.equal(usesClaudeNativeAutoPermissions("Auto"), true);
  assert.equal(usesClaudeNativeAutoPermissions("acceptEdits"), false);
  assert.equal(usesClaudeNativeAutoPermissions(undefined), false);
});

test("permission hook leaves Claude auto mode outside the Lictor proxy", () => {
  assert.equal(shouldProxyPermissionRequest({ permission_mode: "auto" }), false);
  assert.equal(shouldProxyPermissionRequest({ permission_mode: " AUTO " }), false);
  assert.equal(shouldProxyPermissionRequest({ permission_mode: "acceptEdits" }), true);
  assert.equal(shouldProxyPermissionRequest({}), true);
});
