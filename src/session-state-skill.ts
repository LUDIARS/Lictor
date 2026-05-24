import type { RepoStat } from "./stat.js";
import { renderSkillMd, type SkillInjector } from "./skill-injector.js";

/**
 * `lictor-session-state` — short, frequently-overwritten skill containing
 * the current git snapshot. Lives under the per-session skill dir; live-
 * reloaded by claude's file watcher.
 *
 * Intentionally tiny (under 1 KiB) — this is loaded into every turn, so we
 * don't want to balloon context with a verbose dump.
 */
export function writeSessionStateSkill(injector: SkillInjector, stat: RepoStat | null): void {
  if (!stat) return;
  const lines: string[] = [];
  lines.push(`Snapshot at ${stat.gathered_at} (refreshed every 10 min by Lictor).`);
  lines.push("");
  lines.push(`- branch: \`${stat.branch ?? "(detached)"}\``);
  if (stat.upstream) lines.push(`- upstream: \`${stat.upstream}\``);
  lines.push(
    `- working tree: ${stat.dirty ? "**dirty**" : "clean"} ` +
      `(staged=${stat.staged_count}, unstaged=${stat.unstaged_count}, untracked=${stat.untracked_count})`,
  );
  lines.push(`- unpushed commits ahead of upstream: **${stat.unpushed_count}**`);
  if (stat.last_commit) {
    lines.push(
      `- last commit: \`${stat.last_commit.sha.slice(0, 8)}\` at ${stat.last_commit.iso} — ${stat.last_commit.subject}`,
    );
  }

  try {
    injector.writeSkill(
      "lictor-session-state",
      renderSkillMd({
        name: "lictor-session-state",
        description: "Live git snapshot for the current Lictor-wrapped session (auto-refreshed)",
        body: lines.join("\n"),
      }),
    );
  } catch {
    // best-effort
  }
}
