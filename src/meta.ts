import { hostname } from "node:os";
import type { ConcordiaPersona } from "./concordia-types.js";

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
  };
}

// Re-export for callers that just want the bare base.
export { gatherBaseMeta as gatherMeta };
