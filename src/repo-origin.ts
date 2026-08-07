import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 5_000;

export type RepoOriginReader = (cwd: string) => string | null;

function redactHttpOriginCredentials(origin: string): string {
  return origin.replace(/^(https?:\/\/)[^/?#]*@/i, "$1");
}

/**
 * Read remote.origin.url for a repository without exposing git failures to
 * the caller. Git resolves linked worktrees through their shared config.
 */
function readGitRepoOrigin(cwd: string): string | null {
  try {
    const result = spawnSync(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true },
    );
    if (result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

/**
 * Resolve a repository's configured origin URL. A missing remote, non-git
 * directory, unavailable git executable, or blank value is represented as
 * null so Concordia receives an explicit value in every session payload.
 * HTTP(S) userinfo is removed so credentials configured in a remote URL are
 * never forwarded to Concordia.
 */
export function readRepoOrigin(
  cwd: string,
  readOrigin?: RepoOriginReader,
): string | null {
  try {
    const origin = (readOrigin ?? readGitRepoOrigin)(cwd)?.trim();
    return origin ? redactHttpOriginCredentials(origin) : null;
  } catch {
    return null;
  }
}

/** Add the origin resolved from repo_path to a Concordia session payload. */
export function withRepoOrigin<T extends { repo_path: string }>(payload: T): T & {
  repo_origin: string | null;
} {
  return { ...payload, repo_origin: readRepoOrigin(payload.repo_path) };
}
