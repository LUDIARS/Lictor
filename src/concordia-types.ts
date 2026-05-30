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
  in_reply_to?: number;
  /**
   * Lictor が握る送信先 Discord channel ID (spec/discord-lictor-relay.md)。
   * 指定すると Concordia egress はこの channel に直接 webhook 送信する
   * (session→channel ルックアップを介さない = 返信混線の根治)。
   */
  discord_channel_id?: string;
}

/**
 * `GET /v1/sessions/:id/discord-channels` のレスポンス。Lictor が起動時に
 * 取得し、自分の session channel + meta channel ID 群を保持する。
 * channel 作成は非同期なので session_channel_id は初回 null になりうる。
 */
export interface DiscordChannels {
  ok: boolean;
  session_channel_id: string | null;
  session_channel_status?: string | null;
  meta_channels: {
    chitchat: string | null;
    consultation: string | null;
    houkoku: string | null;
    system: string | null;
  };
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
  repo_origin?: string | null;
  /**
   * Shallow merge into Concordia's session.metadata. `null` value deletes
   * a key. Lictor uses this to publish `lictor_port` post-spawn — see
   * wrap.ts where the PATCH fires after startSidecar resolves.
   */
  metadata?: Record<string, unknown>;
}

export interface DeleteSessionResponse {
  report?: unknown;
  [k: string]: unknown;
}
