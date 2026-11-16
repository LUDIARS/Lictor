import { resolve } from "node:path";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:376447ed */
import augurContract_fa73330d from './contracts/task-set-args.contract.js'; /* augur-inject:contract-predicate:ee4c18f6 */

/**
 * `lictor cli task set [--repo <checkout>] [--branch <b>] [--desc <text>]` の引数。
 * `--repo` は Cc の task-branch ゲートが拒否文で案内する登録コマンドの一部 (checkout の登録を足す)。
 * 相対パスは CLI を打った cwd で解決する (sidecar の cwd とは違うので、ここで絶対パスにする)。
 * `--desc` は後続トークンを全部吸うので、`--repo` / `--branch` はその前に置く。
 */
export interface TaskSetPayload {
  repo?: string;
  branch?: string;
  desc?: string;
}

export type TaskSetParse =
  | { ok: true; payload: TaskSetPayload }
  | { ok: false; help: true; usage: string }
  | { ok: false; help?: false; error: string };

export const TASK_SET_USAGE = [
  "usage: lictor cli task set [--repo <checkout>] [--branch <b>] [--desc <text>]",
  "  --repo <checkout>  add a registration for that git checkout (relative paths resolve against the cwd).",
  "                     Without --branch, the checkout's current branch is used.",
  "  --branch <b>       branch to register.",
  "  --desc <text>      task description. It takes every remaining word, so put --repo / --branch before it.",
].join("\n");

const HELP_FLAGS = new Set(["--help", "-h"]);

export function parseTaskSetArgs(args: readonly string[], cwd: string): TaskSetParse {
  const payload: TaskSetPayload = {};
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (HELP_FLAGS.has(tok)) {
      return { ok: false, help: true, usage: TASK_SET_USAGE };
    } else if (tok === "--branch" && i + 1 < args.length) {
      payload.branch = args[++i];
    } else if (tok === "--repo" && i + 1 < args.length) {
      payload.repo = resolve(cwd, args[++i]!);
    } else if (tok === "--desc" && i + 1 < args.length) {
      // Allow trailing tokens to form the description if not quoted in shell.
      payload.desc = args.slice(i + 1).join(" ");
      break;
    } else {
      return { ok: false, error: `lictor cli task set: unexpected arg '${tok}'\n${TASK_SET_USAGE}` };
    }
  }
  if (payload.repo === undefined && payload.branch === undefined && payload.desc === undefined) {
    return { ok: false, error: TASK_SET_USAGE };
  }
  return { ok: true, payload };
}
// @ts-expect-error augur-inject
parseTaskSetArgs = contract(parseTaskSetArgs, { ...augurContract_fa73330d, contractId: 'C-3', mode: 'observe', sample: 1, where: 'src/task-set-args.ts:30', rule: 'contract-wrap', id: 'fa73330d' }); /* augur-inject:contract-wrap:fa73330d */
