import { resolve } from "node:path";

/**
 * `lictor cli task set [--repo <checkout>] [--branch <b>] [--desc <text>]` の引数。
 * `--repo` は Cc の task-branch ゲートが拒否文で案内する登録コマンドの一部 (checkout の登録を足す)。
 * 相対パスは CLI を打った cwd で解決する (sidecar の cwd とは違うので、ここで絶対パスにする)。
 */
export interface TaskSetPayload {
  repo?: string;
  branch?: string;
  desc?: string;
}

export type TaskSetParse = { ok: true; payload: TaskSetPayload } | { ok: false; error: string };

export const TASK_SET_USAGE = "usage: lictor cli task set [--repo <checkout>] [--branch <b>] [--desc <text>] (--repo には --branch が要る)";

export function parseTaskSetArgs(args: readonly string[], cwd: string): TaskSetParse {
  const payload: TaskSetPayload = {};
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--branch" && i + 1 < args.length) {
      payload.branch = args[++i];
    } else if (tok === "--repo" && i + 1 < args.length) {
      payload.repo = resolve(cwd, args[++i]!);
    } else if (tok === "--desc" && i + 1 < args.length) {
      // Allow trailing tokens to form the description if not quoted in shell.
      payload.desc = args.slice(i + 1).join(" ");
      break;
    } else {
      return { ok: false, error: `lictor cli task set: unexpected arg '${tok}'` };
    }
  }
  if (payload.branch === undefined && payload.desc === undefined) return { ok: false, error: TASK_SET_USAGE };
  if (payload.repo !== undefined && !payload.branch) return { ok: false, error: TASK_SET_USAGE };
  return { ok: true, payload };
}
