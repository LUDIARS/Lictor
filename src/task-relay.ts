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
When the user instructs you to work on something and you've decided on the
implementation branch, declare it to Lictor so other LUDIARS sessions and the
Concordia dashboard can see what this session is doing.

\`\`\`sh
# minimal — only declare the task description (branch is auto-detected from HEAD)
lictor cli task set --desc "Cernere auth bug fix (#142)"

# explicit branch + description
lictor cli task set --branch feat/cernere-auth-fix --desc "Cernere auth bug fix (#142)"
\`\`\`

If you skip this, Lictor will catch the branch change automatically within
60 seconds (via \`git rev-parse\` polling), but the **task description**
slot in Concordia will stay empty — the dashboard will show "feat/x" without
context. One \`lictor cli task set --desc "..."\` per task fixes that.

Re-declare whenever you switch task or branch.
`;
  try {
    injector.writeSkill(
      "lictor-task-protocol",
      renderSkillMd({
        name: "lictor-task-protocol",
        description: "How to declare your current task / branch to Lictor (call this when you start work)",
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
