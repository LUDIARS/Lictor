import { test } from "node:test";
import assert from "node:assert/strict";
import { mayEmitDecision } from "../src/permission-hook.js";
import { usesClaudeNativeAutoPermissions } from "../src/permission-mode.js";
import { classifyPermissionRequest } from "../src/permission-classify.js";

test("usesClaudeNativeAutoPermissions recognises only Claude's current auto mode", () => {
  assert.equal(usesClaudeNativeAutoPermissions("auto"), true);
  assert.equal(usesClaudeNativeAutoPermissions(" AUTO "), true);
  assert.equal(usesClaudeNativeAutoPermissions("Auto"), true);
  assert.equal(usesClaudeNativeAutoPermissions("acceptEdits"), false);
  assert.equal(usesClaudeNativeAutoPermissions(undefined), false);
});

test("auto mode never gets a Lictor decision on top of Claude's own", () => {
  assert.equal(mayEmitDecision({ permission_mode: "auto" }), false);
  assert.equal(mayEmitDecision({ permission_mode: " AUTO " }), false);
  assert.equal(mayEmitDecision({ permission_mode: "acceptEdits" }), true);
  assert.equal(mayEmitDecision({}), true);
});

test("auto mode requests are recorded, not gated", () => {
  // 記録のためだけに sidecar へ渡る。 hook は掴まないので全コマンドでカードは出ない。
  assert.equal(classifyPermissionRequest({ permission_mode: "auto", tool_name: "Bash" }), "record-only");
  assert.equal(
    classifyPermissionRequest({ permission_mode: "auto", tool_name: "Bash", guard_result: "deny" }),
    "record-only",
  );
  // auto 以外は従来どおり。
  assert.equal(
    classifyPermissionRequest({ permission_mode: "acceptEdits", tool_name: "Read" }),
    "self-processable",
  );
  assert.equal(
    classifyPermissionRequest({ permission_mode: "acceptEdits", tool_name: "Bash" }),
    "user-confirmation",
  );
});
