import { isAbsolute } from "node:path";
import type { ConcordiaClient } from "./concordia.js";

/**
 * `lictor cli task set --repo <checkout> --branch <b>` の中継。Cc の task-branch ゲートが拒否文で案内する
 * 登録コマンドで、先頭の登録を残したまま checkout の登録を足す (Cc `PATCH /v1/sessions/:id/working-targets`)。
 * ゲートの復旧手段なので best-effort にせず、失敗は呼び出し側へ返す (黙って成功扱いにすると同じ拒否が続く)。
 */
export type WorkingTargetRelayResult =
  | { ok: true; registration: unknown }
  | { ok: false; status: number; error: string };

export async function relayWorkingTarget(opts: {
  client: Pick<ConcordiaClient, "addWorkingTarget"> | null;
  sessionId: string | null;
  repo: string;
  branch: string | undefined;
}): Promise<WorkingTargetRelayResult> {
  const repo = opts.repo.trim();
  const branch = opts.branch?.trim();
  if (!repo || !isAbsolute(repo)) return { ok: false, status: 400, error: "repo must be an absolute path" };
  if (!branch) return { ok: false, status: 400, error: "--repo requires --branch" };
  if (!opts.client || !opts.sessionId) return { ok: false, status: 503, error: "Concordia session is not bound" };
  try {
    const reply = await opts.client.addWorkingTarget(opts.sessionId, { repo, branch });
    const registration = (reply as { registration?: unknown } | null)?.registration ?? null;
    return { ok: true, registration };
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) };
  }
}
