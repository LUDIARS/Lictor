import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { TaskSetPayload } from "./task-set-args.js";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:54852483 */
import augurContract_599076b6 from './contracts/task-set-repo.contract.js'; /* augur-inject:contract-predicate:79b64f71 */

/**
 * `lictor cli task set --repo` の checkout 検査。CLI 側 (呼び出し元の端末) で行い、
 * 存在しない path / git checkout でない path を Cc へ送らない。`--branch` 省略時はその checkout の現在 branch を補う。
 */
export interface CheckoutProbe {
  isDirectory(path: string): boolean;
  /** git checkout なら現在の branch (detached なら "HEAD")、checkout でなければ null。 */
  currentBranch(path: string): string | null;
}

export type TaskSetRepoResult = { ok: true; payload: TaskSetPayload } | { ok: false; error: string };

export function resolveTaskSetRepo(payload: TaskSetPayload, probe: CheckoutProbe): TaskSetRepoResult {
  const repo = payload.repo;
  if (repo === undefined) return { ok: true, payload };
  if (!probe.isDirectory(repo)) return { ok: false, error: `lictor cli task set: --repo '${repo}' does not exist` };
  const current = probe.currentBranch(repo);
  if (current === null) return { ok: false, error: `lictor cli task set: --repo '${repo}' is not a git checkout` };
  if (payload.branch) return { ok: true, payload };
  if (!current || current === "HEAD") {
    return { ok: false, error: `lictor cli task set: --repo '${repo}' has no current branch (detached HEAD); pass --branch` };
  }
  return { ok: true, payload: { ...payload, branch: current } };
}
// @ts-expect-error augur-inject
resolveTaskSetRepo = contract(resolveTaskSetRepo, { ...augurContract_599076b6, contractId: 'C-4', mode: 'observe', sample: 1, where: 'src/task-set-repo.ts:17', rule: 'contract-wrap', id: '599076b6' }); /* augur-inject:contract-wrap:599076b6 */

export const gitCheckoutProbe: CheckoutProbe = {
  isDirectory(path) {
    try {
      return existsSync(path) && statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  currentBranch(path) {
    try {
      const inside = execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      }).trim();
      if (inside !== "true") return null;
      return execFileSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      }).trim();
    } catch {
      return null;
    }
  },
};
