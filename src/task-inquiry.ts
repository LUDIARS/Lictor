import type { ConcordiaClient } from "./concordia.js";

// @implements spec/feature/task-inquiry.md

export interface TaskInquirySnapshot {
  activeRepos: string[];
  branch: string | null;
  hasUncommittedChanges: boolean;
  recentPr: { number: number; outcome: string } | null;
  task: string | null;
}

/** Lictor が既に持つ機械的な現況だけを、監査しやすい固定順で整形する。 */
export function buildTaskInquiryContext(snapshot: TaskInquirySnapshot): string {
  return [
    `active repos: ${snapshot.activeRepos.length > 0 ? snapshot.activeRepos.join(", ") : "none"}`,
    `branch: ${snapshot.branch ?? "unknown"}`,
    `uncommitted changes: ${snapshot.hasUncommittedChanges ? "yes" : "no"}`,
    `recent PR: ${snapshot.recentPr ? `#${snapshot.recentPr.number} (${snapshot.recentPr.outcome})` : "none"}`,
    `current task: ${snapshot.task ?? "none"}`,
  ].join("\n");
}

/**
 * Cc の completion ブラックボックス通知を受けた後だけ呼ぶ送信役。
 * 旧 Cc の 404 や一時停止は session 本体を壊さない best-effort とする。
 */
export async function reportTaskInquiry(
  client: ConcordiaClient | null,
  sessionId: string | null,
  snapshot: TaskInquirySnapshot,
): Promise<void> {
  if (!client || !sessionId) return;
  try {
    await client.inquiry({
      session_id: sessionId,
      category: "タスク",
      context: buildTaskInquiryContext(snapshot),
    });
  } catch {
    // Cc の新 API が未デプロイでも wrapped session は継続できる。
  }
}
