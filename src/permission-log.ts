/**
 * Structured local audit trail for the PreToolUse permission proxy.
 *
 * Every permission request is recorded here, including the ones that are
 * never posted to Concordia, so the suppression behaviour stays diagnosable
 * from the wrapper's own stderr.
 */

import type { PermissionRequestKind } from "./permission-classify.js";

export type PermissionLogAction =
  | "deferred"
  | "suppressed-progressed"
  | "posted-after-defer"
  | "posted-immediately"
  | "post-failed";

export interface PermissionLogEntry {
  action: PermissionLogAction;
  request_id: string;
  kind: PermissionRequestKind;
  tool_name: string;
  deferred_ms: number;
  error?: string;
}

export function writePermissionLog(entry: PermissionLogEntry): void {
  try {
    process.stderr.write(`${JSON.stringify({ event: "permission-check", ...entry })}\n`);
  } catch {
    // Local audit logging must not interfere with the permission path.
  }
}
