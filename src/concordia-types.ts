/**
 * Subset of Concordia API types Lictor depends on. Mirrors the surface we
 * actually call — not exhaustive.
 */

export interface ConcordiaSessionRegister {
  id: string;
  provider: string;
  repo_path: string;
  host: string;
  branch?: string | null;
  transcript_path?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ConcordiaPersona {
  // Concordia returns at least these — additional fields tolerated.
  name?: string;
  role?: string;
  role_label?: string;
  [k: string]: unknown;
}

export interface ConcordiaSessionResponse {
  session: {
    id: string;
    metadata?: { role_label?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  persona?: ConcordiaPersona | null;
  peers?: Array<Record<string, unknown>>;
  lost_candidates?: Array<Record<string, unknown>>;
  processes?: Array<Record<string, unknown>>;
  process_stream_url?: string;
}

export interface ConcordiaChatPayload {
  channel: string;
  text: string;
  author_label: string;
  session_id?: string;
  scope?: string;
}

export interface ConcordiaEventPayload {
  kind: string;
  payload?: unknown;
  ts?: number;
}

export interface ConcordiaConflictsResponse {
  conflicts?: Array<Record<string, unknown>>;
  branches?: Array<{ branch: string; count: number }>;
  [k: string]: unknown;
}

export interface PendingTask {
  id: string;
  kind: string;
  payload?: unknown;
  created_at?: string;
  [k: string]: unknown;
}

export interface PendingTasksResponse {
  tasks: PendingTask[];
}

export interface SessionPatch {
  current_task?: string;
  branch?: string;
  repo_path?: string;
}

export interface DeleteSessionResponse {
  report?: unknown;
  [k: string]: unknown;
}
