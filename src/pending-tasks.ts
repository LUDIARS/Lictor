import type { ConcordiaClient } from "./concordia.js";
import type { PendingTask } from "./concordia-types.js";
import { renderSkillMd, type SkillInjector } from "./skill-injector.js";

const SKILL_NAME = "lictor-pending-tasks";

/**
 * Poll Concordia for pending tasks queued by other sessions, project them
 * into the `lictor-pending-tasks` skill. Always (re)writes the file so
 * claude's file watcher always sees up-to-date content; an empty list is
 * rendered with a "no pending tasks" sentinel so the skill doesn't flicker
 * in and out of existence.
 */
export async function refreshPendingTasksSkill(
  client: ConcordiaClient,
  sessionId: string,
  injector: SkillInjector,
): Promise<number> {
  let tasks: PendingTask[];
  try {
    const res = await client.pendingTasks(sessionId);
    tasks = Array.isArray(res?.tasks) ? res.tasks : [];
  } catch {
    return -1; // network error, leave skill alone
  }

  const body = renderTasksBody(tasks);
  try {
    injector.writeSkill(
      SKILL_NAME,
      renderSkillMd({
        name: SKILL_NAME,
        description: `Pending tasks queued for this session (${tasks.length} open)`,
        body,
      }),
    );
  } catch {
    // ignore
  }
  return tasks.length;
}

function renderTasksBody(tasks: PendingTask[]): string {
  if (tasks.length === 0) {
    return "_No pending tasks. Other sessions / services have not queued anything for you._";
  }
  const lines: string[] = [];
  lines.push(`${tasks.length} pending task${tasks.length === 1 ? "" : "s"}:\n`);
  for (const t of tasks) {
    const when = t.created_at ? ` (queued ${t.created_at})` : "";
    const payload = t.payload !== undefined ? "\n   payload: " + truncate(JSON.stringify(t.payload), 200) : "";
    lines.push(`1. **[${t.kind}]** \`${t.id}\`${when}${payload}`);
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
