import type { ConcordiaClient } from "./concordia.js";
import { renderSkillMd, type SkillInjector } from "./skill-injector.js";

const SKILL_NAME = "lictor-current-task";

export interface TaskState {
  branch: string | null;
  desc: string | null;
  updatedAt: string | null;
}

/**
 * In-memory record of the most recently relayed task. Lictor reads / mutates
 * via the helpers below; nothing else should touch the field directly.
 */
export function newTaskState(): TaskState {
  return { branch: null, desc: null, updatedAt: null };
}

/**
 * Push current_task / branch to Concordia, fire a `lictor.task.changed`
 * event, and refresh the `lictor-current-task` skill so claude has a
 * memory of what it claimed to be working on. All steps are best-effort —
 * a Concordia outage doesn't block the wrapped session.
 */
export async function relayTask(opts: {
  client: ConcordiaClient | null;
  sessionId: string | null;
  injector: SkillInjector | null;
  state: TaskState;
  branch?: string | null;
  desc?: string | null;
  source: "auto" | "explicit";
}): Promise<TaskState> {
  const branch = opts.branch === undefined ? opts.state.branch : opts.branch;
  const desc = opts.desc === undefined ? opts.state.desc : opts.desc;

  const branchChanged = branch !== opts.state.branch;
  const descChanged = desc !== opts.state.desc;
  if (!branchChanged && !descChanged) return opts.state;

  const next: TaskState = {
    branch,
    desc,
    updatedAt: new Date().toISOString(),
  };

  if (opts.client && opts.sessionId) {
    try {
      const patch: { branch?: string; current_task?: string } = {};
      if (branch) patch.branch = branch;
      if (desc) patch.current_task = desc;
      if (Object.keys(patch).length > 0) {
        await opts.client.patchSession(opts.sessionId, patch);
      }
      await opts.client.event(opts.sessionId, {
        kind: "lictor.task.changed",
        payload: { branch, desc, source: opts.source, ts: next.updatedAt },
      });
    } catch {
      // best-effort; skill update still proceeds below
    }
  }

  if (opts.injector) {
    try {
      opts.injector.writeSkill(
        SKILL_NAME,
        renderSkillMd({
          name: SKILL_NAME,
          description: `Current task claimed by this Lictor-wrapped session${
            branch ? ` (branch ${branch})` : ""
          }`,
          body: renderBody(next, opts.source),
        }),
      );
    } catch {
      // ignore
    }
  }

  return next;
}

/**
 * Seed `lictor-task-protocol` — a one-time skill that tells the wrapped
 * claude HOW to declare its working branch / task so other LUDIARS
 * sessions can see it on the dashboard.
 */
export function seedTaskProtocolSkill(injector: SkillInjector): void {
  const body = `\
When the user asks for an implementation, use the Cc-backed implementation
fast path. It resolves the repository, origin, checkout branch, and project code
from cwd, so do not search PROJECT-CODES.md or assemble a manual claim first.

\`\`\`sh
lictor cli implement begin --task "Cernere auth bug fix (#142)"
\`\`\`

Use \`lictor cli implement service <code> <start|stop|restart>\` for a
service operation and \`lictor cli implement review\` after committing.
Cc batches testing claim/release and Revisor submit/retry over their existing state
for 60 seconds.

Do not enable this workflow for ordinary conversation, investigation,
consultation, or judgment sessions. Those sessions keep their normal freedom.

The lower-level \`lictor cli task set\` remains available for non-implementation
coordination and compatibility.
`;
  try {
    injector.writeSkill(
      "lictor-task-protocol",
      renderSkillMd({
        name: "lictor-task-protocol",
        description: "Use implementation fast paths without manual project-code or endpoint lookup",
        body,
      }),
    );
  } catch {
    // ignore
  }
}

function renderBody(state: TaskState, source: "auto" | "explicit"): string {
  const lines: string[] = [];
  lines.push(`Last update: ${state.updatedAt ?? "(unset)"} (source: ${source})`);
  lines.push("");
  lines.push(`- branch: \`${state.branch ?? "(unknown)"}\``);
  lines.push(`- description: ${state.desc ? `**${state.desc}**` : "_(none set — run \`lictor cli task set --desc \"...\"\`)_"}`);
  return lines.join("\n");
}
