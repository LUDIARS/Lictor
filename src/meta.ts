import { hostname } from "node:os";

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
}

export function gatherMeta(): Meta {
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
  };
}
