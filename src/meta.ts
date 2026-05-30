import { hostname } from "node:os";
import type { ConcordiaPersona, DiscordChannels } from "./concordia-types.js";

export interface Meta {
  lictor_pid: number;
  parent_pid: number;
  cwd: string;
  start_iso: string;
  hostname: string;
  platform: NodeJS.Platform;
  wt_session: string | null;
  term_program: string | null;
  term: string | null;

  /** Wrapped provider name (`claude` / `codex`). null until runWrapped sets it. */
  provider: string | null;

  // Populated after Concordia registration. Null until then (and stays null
  // when Concordia is disabled or unreachable).
  session_id: string | null;
  persona: ConcordiaPersona | null;
  role_label: string | null;

  /**
   * 自分の session に紐づく Discord channel ID 群。登録後に Concordia から
   * 取得して保持する (spec/discord-lictor-relay.md)。null = 未取得 / Concordia
   * 無効 / channel 未作成。sidecar の /v1/chat がここから送信先を解決する。
   */
  discord: DiscordChannels | null;
}

export function gatherBaseMeta(): Meta {
  return {
    lictor_pid: process.pid,
    parent_pid: process.ppid,
    cwd: process.cwd(),
    start_iso: new Date().toISOString(),
    hostname: hostname(),
    platform: process.platform,
    wt_session: process.env.WT_SESSION ?? null,
    term_program: process.env.TERM_PROGRAM ?? null,
    term: process.env.TERM ?? null,
    provider: null,
    session_id: null,
    persona: null,
    role_label: null,
    discord: null,
  };
}

// Re-export for callers that just want the bare base.
export { gatherBaseMeta as gatherMeta };
