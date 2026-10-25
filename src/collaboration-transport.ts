/** Cc is the authority for delegation relationships and message delivery. */
export interface CollaborationRun {
  id: string;
  parent_session_id: string | null;
  child_session_id: string | null;
  status: string;
  call_name: string;
}

export class CollaborationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface CollaborationTransport {
  list(parent: string, signal: AbortSignal): Promise<{ runs: CollaborationRun[]; limit: number }>;
  run(id: string, signal: AbortSignal): Promise<CollaborationRun>;
  observe(peer: string, signal: AbortSignal): Promise<{ status: string; messages: unknown[] }>;
  send(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseRun(value: unknown): CollaborationRun {
  if (!record(value) || typeof value.id !== "string" || typeof value.status !== "string"
    || typeof value.call_name !== "string"
    || !(value.parent_session_id === null || typeof value.parent_session_id === "string")
    || !(value.child_session_id === null || typeof value.child_session_id === "string")) {
    throw new CollaborationError(502, "invalid_collaboration_run");
  }
  return { id: value.id, status: value.status, call_name: value.call_name,
    parent_session_id: value.parent_session_id, child_session_id: value.child_session_id };
}

export function createCollaborationTransport(baseUrl: string, fetchFn: typeof fetch = fetch): CollaborationTransport {
  async function request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      });
    } catch {
      throw new CollaborationError(502, body === undefined
        ? "collaboration_unavailable" : "collaboration_send_outcome_unknown_do_not_resend");
    }
    if (!response.ok) throw new CollaborationError(response.status, body !== undefined && response.status >= 500
      ? "collaboration_send_outcome_unknown_do_not_resend" : "collaboration_upstream_rejected");
    try { return await response.json(); } catch {
      throw new CollaborationError(502, body === undefined
        ? "invalid_collaboration_response" : "collaboration_send_outcome_unknown_do_not_resend");
    }
  }
  return {
    async list(parent, signal) {
      const value = await request(`/v1/delegation/runs?parent_session=${encodeURIComponent(parent)}&limit=500`, signal);
      if (!record(value) || !Array.isArray(value.runs) || typeof value.limit !== "number") {
        throw new CollaborationError(502, "invalid_collaboration_list");
      }
      return { runs: value.runs.map(parseRun), limit: value.limit };
    },
    async run(id, signal) {
      const value = await request(`/v1/delegation/runs/${encodeURIComponent(id)}`, signal);
      return parseRun(record(value) ? value.run : null);
    },
    async observe(peer, signal) {
      const path = `/v1/sessions/${encodeURIComponent(peer)}`;
      const [session, history] = await Promise.all([
        request(path, signal), request(`${path}/messages?limit=20`, signal),
      ]);
      if (!record(session) || !record(session.session) || typeof session.session.status !== "string"
        || !record(history) || !Array.isArray(history.messages)) {
        throw new CollaborationError(502, "invalid_collaboration_observation");
      }
      return { status: session.session.status, messages: history.messages };
    },
    send: (path, body, signal) => request(path, signal, body),
  };
}
