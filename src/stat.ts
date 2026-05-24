import { spawnSync } from "node:child_process";

export interface RepoStat {
  repo_path: string;
  branch: string | null;
  dirty: boolean;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  unpushed_count: number;
  last_commit: { sha: string; iso: string; subject: string } | null;
  upstream: string | null;
  /** ISO timestamp this stat was gathered. */
  gathered_at: string;
}

const TIMEOUT_MS = 5_000;

function git(args: string[], cwd: string): string | null {
  try {
    const r = spawnSync("git", args, {
      cwd,
      timeout: TIMEOUT_MS,
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status !== 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

export function gatherRepoStat(cwd: string): RepoStat {
  const branch = trimOrNull(git(["rev-parse", "--abbrev-ref", "HEAD"], cwd));
  const upstream = trimOrNull(
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd),
  );

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const status = git(["status", "--porcelain=v1"], cwd);
  if (status !== null) {
    for (const line of status.split("\n")) {
      if (!line) continue;
      const idx = line[0] ?? " ";
      const wt = line[1] ?? " ";
      if (idx === "?" && wt === "?") {
        untracked++;
        continue;
      }
      if (idx !== " " && idx !== "?") staged++;
      if (wt !== " " && wt !== "?") unstaged++;
    }
  }

  let unpushed = 0;
  if (upstream) {
    const ahead = git(["rev-list", "--count", `${upstream}..HEAD`], cwd);
    unpushed = ahead === null ? 0 : Number(ahead.trim()) || 0;
  }

  let lastCommit: RepoStat["last_commit"] = null;
  const log = git(["log", "-1", "--format=%H%x09%cI%x09%s"], cwd);
  if (log) {
    const [sha, iso, ...rest] = log.trim().split("\t");
    if (sha && iso) {
      lastCommit = { sha, iso, subject: rest.join("\t") };
    }
  }

  return {
    repo_path: cwd,
    branch,
    dirty: staged + unstaged + untracked > 0,
    staged_count: staged,
    unstaged_count: unstaged,
    untracked_count: untracked,
    unpushed_count: unpushed,
    last_commit: lastCommit,
    upstream,
    gathered_at: new Date().toISOString(),
  };
}

function trimOrNull(s: string | null): string | null {
  if (s === null) return null;
  const t = s.trim();
  return t === "" ? null : t;
}
