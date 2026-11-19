import type { ConcordiaClient } from "./concordia.js";
import type { PendingTask } from "./concordia-types.js";
import { PENDING_STAT_INSTRUCTIONS_PATH, type PendingStatInstructions } from "./pending-stat-instructions.js";
import { renderSkillMd, type SkillInjector } from "./skill-injector.js";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:d07b339b */
import augurContract_f340f33e from './contracts/pending-task-payload.contract.js'; /* augur-inject:contract-predicate:94405d8b */

const SKILL_NAME = "lictor-pending-tasks";
const PAYLOAD_PREVIEW_LENGTH = 200;

/**
 * Poll Concordia for pending tasks queued by other sessions, project them
 * into the `lictor-pending-tasks` skill. Always (re)writes the file so
 * claude's file watcher always sees up-to-date content; an empty list is
 * rendered with a "no pending tasks" sentinel so the skill doesn't flicker
 * in and out of existence.
 */
export async function refreshPendingTasksSkill(
  client: Pick<ConcordiaClient, "pendingTasks">,
  sessionId: string,
  injector: Pick<SkillInjector, "writeSkill">,
  instructions: PendingStatInstructions,
): Promise<number> {
  let tasks: PendingTask[];
  try {
    const res = await client.pendingTasks(sessionId);
    tasks = Array.isArray(res?.tasks) ? res.tasks : [];
  } catch {
    return -1; // network error, leave skill alone
  }

  const body = renderTasksBody(tasks, instructions);
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

function renderTasksBody(tasks: PendingTask[], instructions: PendingStatInstructions): string {
  if (tasks.length === 0) {
    return "_No pending tasks. Other sessions / services have not queued anything for you._";
  }
  const lines: string[] = [];
  lines.push(`${tasks.length} pending task${tasks.length === 1 ? "" : "s"}:\n`);
  for (const t of tasks) {
    const when = t.created_at ? ` (queued ${t.created_at})` : "";
    const payload = renderTaskPayload(t, instructions);
    lines.push(`1. **[${t.kind}]** \`${t.id}\`${when}${payload}`);
  }
  return lines.join("\n");
}

export function renderTaskPayload(task: PendingTask, instructions: PendingStatInstructions): string {
  if (task.payload === undefined) return "";
  const json = JSON.stringify(task.payload);
  const preview = "\n   payload: " + truncate(json, PAYLOAD_PREVIEW_LENGTH);
  if (json.length <= PAYLOAD_PREVIEW_LENGTH) return preview;

  const id = instructions.remember(task);
  if (id === undefined) return preview;
  return preview + `\n   指示全文は自セッションの sidecar (127.0.0.1、LICTOR_PORT) に \`GET ${PENDING_STAT_INSTRUCTIONS_PATH}${id}\` で取得できます。`;
}
// @ts-expect-error augur-inject
renderTaskPayload = contract(renderTaskPayload, { ...augurContract_f340f33e, contractId: 'C-8', mode: 'observe', sample: 1, where: 'src/pending-tasks.ts:60', rule: 'contract-wrap', id: 'f340f33e' }); /* augur-inject:contract-wrap:f340f33e */

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
