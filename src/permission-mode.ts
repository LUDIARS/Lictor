/**
 * Claude Code's current automatic permission mode is authoritative: Lictor
 * must not replace it with a second, coordinator-backed confirmation flow.
 */
export function usesClaudeNativeAutoPermissions(permissionMode: unknown): boolean {
  return typeof permissionMode === "string" && permissionMode.trim().toLowerCase() === "auto";
}
