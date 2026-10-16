/** @implements LI-BIND-01 — bounded diagnostics for the Cc-owned binding. */
const STAGES = new Set(["session", "workspace", "repository", "project", "persistence"]);
const REASONS = new Set([
  "session_not_found", "session_inactive", "invalid_task", "workspace_denied",
  "invalid_cwd", "git_unavailable", "git_timeout", "git_ownership", "git_not_repository",
  "git_failed", "unnamed_branch", "project_not_registered", "project_ambiguous",
  "identity_unavailable", "stale_session", "persistence_failed", "unexpected_failure",
]);

export class ImplementationBindProxyError extends Error {
  constructor(readonly status: 409 | 502, readonly body: {
    error: "implementation_bind_failed" | "implementation_bind_result_unknown";
    reason: string; stage: string; binding: "unchanged" | "unknown"; guidance: string;
  }) {
    super(body.error);
    this.name = "ImplementationBindProxyError";
  }
}

export function unknownImplementationBind(): ImplementationBindProxyError {
  return new ImplementationBindProxyError(502, {
    error: "implementation_bind_result_unknown", reason: "upstream_unavailable",
    stage: "transport", binding: "unknown",
    guidance: "Inspect the current Concordia session binding before retrying. The request may have committed.",
  });
}

/** Session stamping belongs here; Cc alone resolves and commits the binding. */
export async function requestImplementationBind(
  baseUrl: string, sessionId: string, payload: { cwd: string; task: string },
): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/v1/implementation-tools/bind`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, session_id: sessionId }),
    });
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw unknownImplementationBind();
    if (response.ok) return body;
    const error = body as Record<string, unknown>;
    if (response.status !== 409 || error.error !== "implementation_bind_failed") throw unknownImplementationBind();
    throw new ImplementationBindProxyError(409, {
      error: "implementation_bind_failed",
      reason: typeof error.reason === "string" && REASONS.has(error.reason) ? error.reason : "unexpected_failure",
      stage: typeof error.stage === "string" && STAGES.has(error.stage) ? error.stage : "unknown",
      binding: error.binding === "unchanged" ? "unchanged" : "unknown",
      guidance: "Inspect the current Concordia session binding and the reported prerequisite before retrying the same checkout.",
    });
  } catch (error) {
    if (error instanceof ImplementationBindProxyError) throw error;
    throw unknownImplementationBind();
  }
}
