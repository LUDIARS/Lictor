/**
 * Classifies PreToolUse permission requests without depending on the sidecar
 * or Concordia. Unknown input deliberately stays on the human-confirmation
 * path: an incorrect notification is preferable to an unsafe auto decision.
 */

export type PermissionRequestKind = "self-processable" | "user-confirmation";

export interface PermissionClassificationInput {
  permission_mode?: unknown;
  tool_name?: unknown;
  guard_result?: unknown;
}

const AUTO_PERMISSION_MODES = new Set(["acceptedits", "bypasspermissions", "dontask"]);
const HARMLESS_TOOLS = new Set(["read", "glob", "grep"]);
const ALLOWING_GUARD_RESULTS = new Set(["allow", "allowed", "pass", "passed", "ok"]);

/** Return whether a reported harness guard result explicitly permits the action. */
function guardAllows(guardResult: unknown): boolean {
  if (guardResult === undefined || guardResult === null) return true;
  if (typeof guardResult === "string") {
    return ALLOWING_GUARD_RESULTS.has(guardResult.trim().toLowerCase());
  }
  if (!guardResult || typeof guardResult !== "object") return false;

  const result = guardResult as { decision?: unknown; allowed?: unknown; status?: unknown };
  if (result.allowed === true) return true;
  for (const value of [result.decision, result.status]) {
    if (typeof value === "string" && ALLOWING_GUARD_RESULTS.has(value.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Decide whether an automatically approved, harmless request can defer its
 * human notification. A guard denial, dangerous tool, or unrecognised input
 * always requires immediate human confirmation.
 */
export function classifyPermissionRequest(input: PermissionClassificationInput): PermissionRequestKind {
  if (!guardAllows(input.guard_result)) return "user-confirmation";
  if (typeof input.permission_mode !== "string" || typeof input.tool_name !== "string") {
    return "user-confirmation";
  }
  if (!AUTO_PERMISSION_MODES.has(input.permission_mode.trim().toLowerCase())) {
    return "user-confirmation";
  }
  if (!HARMLESS_TOOLS.has(input.tool_name.trim().toLowerCase())) {
    return "user-confirmation";
  }
  return "self-processable";
}
