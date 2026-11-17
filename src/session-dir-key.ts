/**
 * Lictor のセッション用フォルダ (`~/.claude/lictor/sessions/<sessionId>`) を指す
 * claude.json project key の判定。副作用なし (contract 述語からも使う)。
 * @implements SPEC-SESSION-DIR-TRUST
 */

import {
  type ClaudeProjectEntry,
  comparableProjectKey,
  findProjectKey,
  normalizeProjectKey,
} from "./claude-json.js";

/**
 * key が sessionsRoot の直下 1 階層のフォルダを指すか。
 * @implements SPEC-SESSION-DIR-TRUST
 */
export function isSessionDirKey(key: string, sessionsRoot: string): boolean {
  const root = comparableProjectKey(normalizeProjectKey(sessionsRoot)).replace(/\/+$/, "");
  const candidate = comparableProjectKey(key).replace(/\/+$/, "");
  if (!candidate.startsWith(`${root}/`)) return false;
  const leaf = candidate.slice(root.length + 1);
  return leaf.length > 0 && !leaf.includes("/") && leaf !== "." && leaf !== "..";
}

/**
 * projects の中から、正規化済みのセッション用フォルダ key と同じ場所を指す key を探す。
 * @implements SPEC-SESSION-DIR-TRUST
 */
export function findSessionDirKey(
  projects: Record<string, ClaudeProjectEntry>,
  normalizedSessionDir: string,
): string | undefined {
  return findProjectKey(projects, normalizedSessionDir);
}
