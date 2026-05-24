/**
 * 作業リポジトリ追跡 — ホスト側 Claude Code hook (track-active-repo.sh) が
 * 書き出す状態ファイルを読み、 セッション内で「実際に編集された」 git repo
 * 群を取得する.
 *
 * 取得元: `<state-dir>/active-repos-<claude-session-uuid>.txt`
 *   1 行 = 1 git toplevel. 末尾エントリが「最後に触ったリポ」 = active.
 *
 * Claude Code の statusline / /stat が参照しているのと同じデータソースなので、
 * statusline と同じ精度で active repo を Concordia に流せる.
 *
 * Claude session UUID は transcript-tail が JSONL discovery 経由で得る
 * (`TranscriptTailHandle.getClaudeSessionId`). この module 自体は state dir +
 * UUID を受け取って読み出すだけ.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * State dir の解決. 優先順:
 *  1. env `LICTOR_ACTIVE_REPOS_DIR`
 *  2. env `CLAUDE_PROJECT_DIR/.claude/state` (Claude Code が export する変数)
 *  3. ハードコード `E:\Document\Ars\.claude\state` (本リポ運用の既定値)
 *
 * 該当 dir が存在しなくても文字列はそのまま返す (呼び出し側で existsSync 判定).
 */
export function resolveActiveReposDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LICTOR_ACTIVE_REPOS_DIR && env.LICTOR_ACTIVE_REPOS_DIR.trim()) {
    return env.LICTOR_ACTIVE_REPOS_DIR.trim();
  }
  if (env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.trim()) {
    return join(env.CLAUDE_PROJECT_DIR.trim(), ".claude", "state");
  }
  return "E:\\Document\\Ars\\.claude\\state";
}

/** state file の絶対パスを返す. SID は Claude session UUID. */
export function activeReposPath(stateDir: string, claudeSessionId: string): string {
  return join(stateDir, `active-repos-${claudeSessionId}.txt`);
}

/**
 * State file を読み、 dedup・空行除外・trim 済みの repo パス配列を返す.
 * 順序は file 出現順 (= track-active-repo.sh の append 順 = 触った順) を維持する.
 *
 * ファイル無し / 読み取りエラーは空配列を返す (hook 未起動 / 別セッション扱い).
 */
export function readActiveRepos(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * 「現在の active repo」 を選ぶ. state file の末尾エントリ (最後に hook が追記した
 * = 直近に触れたリポ). 空ならフォールバックの `cwd` を返す.
 */
export function pickActiveRepo(repos: string[], fallback: string): string {
  return repos.length > 0 ? repos[repos.length - 1] : fallback;
}
