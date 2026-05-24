import type { ConcordiaClient } from "./concordia.js";
import type { ConcordiaConflictsResponse } from "./concordia-types.js";
import { renderSkillMd, type SkillInjector } from "./skill-injector.js";

const SKILL_NAME = "lictor-conflicts";

export interface ConflictState {
  /** Number of other sessions touching the same repo/branch. */
  count: number;
  /** Short text to prepend to the terminal title, e.g. "⚠2". null when clear. */
  titleMark: string | null;
}

const CLEAR: ConflictState = { count: 0, titleMark: null };

/**
 * Poll Concordia for active conflicts on (repo, branch). Project the result
 * into both a terminal-title mark and the `lictor-conflicts` skill so
 * claude is aware mid-session.
 */
export async function refreshConflictState(
  client: ConcordiaClient,
  sessionId: string,
  injector: SkillInjector,
  opts: { repo: string; branch?: string | null },
): Promise<ConflictState> {
  let res: ConcordiaConflictsResponse;
  try {
    res = await client.conflicts({
      repo: opts.repo,
      branch: opts.branch ?? undefined,
      excludeSession: sessionId,
    });
  } catch {
    return CLEAR;
  }
  const conflicts = Array.isArray(res?.conflicts) ? res.conflicts : [];
  if (conflicts.length === 0) {
    // Clear skill (write empty sentinel rather than delete — keeps watcher state stable).
    try {
      injector.writeSkill(
        SKILL_NAME,
        renderSkillMd({
          name: SKILL_NAME,
          description: "Active conflicts on (repo, branch) — currently none",
          body: "_No other sessions touching this repo / branch._",
        }),
      );
    } catch {
      // ignore
    }
    return CLEAR;
  }

  const body = renderConflictsBody(conflicts, opts.repo, opts.branch ?? null);
  try {
    injector.writeSkill(
      SKILL_NAME,
      renderSkillMd({
        name: SKILL_NAME,
        description: `${conflicts.length} other session(s) currently on the same repo/branch — proceed with care`,
        body,
      }),
    );
  } catch {
    // ignore
  }
  return { count: conflicts.length, titleMark: `⚠${conflicts.length}` };
}

function renderConflictsBody(
  conflicts: Array<Record<string, unknown>>,
  repo: string,
  branch: string | null,
): string {
  const lines: string[] = [];
  lines.push(`**Conflict watch** — repo=\`${repo}\`${branch ? `, branch=\`${branch}\`` : ""}`);
  lines.push("");
  lines.push(`${conflicts.length} other session(s) currently active here:`);
  lines.push("");
  for (const c of conflicts) {
    const id = String(c.id ?? c.session_id ?? "?");
    const host = c.host ? ` on ${c.host}` : "";
    const cwd = c.repo_path ? ` (${c.repo_path})` : "";
    const br = c.branch ? `, branch \`${c.branch}\`` : "";
    lines.push(`- \`${id}\`${host}${br}${cwd}`);
  }
  lines.push("");
  lines.push("_Coordinate before touching shared files / pushing the same branch._");
  return lines.join("\n");
}
