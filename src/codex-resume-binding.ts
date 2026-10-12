/** Explicit launch intent; never discover a resume target from recency. */
export function explicitCodexResumeThreadId(args: readonly string[]): string | null {
  if (args[0] !== "resume") return null;
  const id = args[1];
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase() : null;
}

/** Resume must not replay old replies or recreate historical questions. */
export function isResumeRelayRecord(line: string, sinceMs: number): boolean {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object") return false;
    const timestamp = (value as { timestamp?: unknown }).timestamp;
    return typeof timestamp === "string" && Date.parse(timestamp) >= sinceMs;
  } catch {
    return false;
  }
}
