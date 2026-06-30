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
 *  2. env `CLAUDE_PROJECT_DIR/.claude/state` (Claude Code が hook 実行時に export する変数)
 *  3. env `LUDIARS_ROOT/.claude/state` (Excubitor が注入するワークスペース root)
 *  4. `process.cwd()/.claude/state` (ポータブル最終手段)
 *
 * これは `.claude/hooks/track-active-repo.sh` がスクリプト相対で書き出す
 * `<workspace-root>/.claude/state` と一致させる必要がある (= Lictor の SessionStart
 * hook が書く transcript ポインタを、 wrap 側 transcript-tail が同じ場所から読むため)。
 * このワークスペースではセッション cwd が常に workspace root なので `process.cwd()`
 * 由来で shell hook と同じ正本に収束する。
 *
 * 旧実装は最終フォールバックが `E:\Document\Ars\.claude\state` のハードコードだった
 * (個人パス直書き)。 E: ドライブが無い環境 (例 D:\LUDIARS 運用) では存在しないドライブ
 * を指し、 SessionStart hook の `claude-transcript-<lictorId>.txt` 書き込みが沈黙失敗
 * → hook 権威モードの transcript-tail が永久に束縛できず中継ゼロ (本番実害 2026-07-01)。
 * org 全体の「E: 直書き廃止・LUDIARS_ROOT / cwd 由来」 移行に合わせて撤廃した。
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
  if (env.LUDIARS_ROOT && env.LUDIARS_ROOT.trim()) {
    return join(env.LUDIARS_ROOT.trim(), ".claude", "state");
  }
  return join(process.cwd(), ".claude", "state");
}

/** state file の絶対パスを返す. SID は Claude session UUID. */
export function activeReposPath(stateDir: string, claudeSessionId: string): string {
  return join(stateDir, `active-repos-${claudeSessionId}.txt`);
}

/**
 * 「現在の Claude session id」 追跡ファイルの絶対パス. キーは Lictor session id
 * (= Concordia session id, `lictor-<uuid>`) で、 SessionStart hook
 * (`lictor cli session-id-hook`) が現 claude session_id を書き込む.
 *
 * `--session-id` で固定した transcript JSONL は `/clear` で別 uuid の新 JSONL に
 * ローテートするが、 transcript-tail は固定ファイルを掴んだまま再 discover しない.
 * このファイルを transcript-tail が poll し、 記録された sid が現在の pin と
 * 変わったら新 `<sid>.jsonl` へ再 pin して中継を継続する.
 */
export function claudeSessionStatePath(stateDir: string, lictorSessionId: string): string {
  return join(stateDir, `claude-session-${lictorSessionId}.txt`);
}

/** {@link claudeSessionStatePath} の中身 (現 claude session id) を読む. 無ければ null. */
export function readClaudeSessionId(path: string): string | null {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v || null;
  } catch {
    return null; // 未作成 (SessionStart hook 未発火) / 読めない
  }
}

/**
 * 「現在の Claude transcript JSONL 実パス」 追跡ファイルの絶対パス. キーは Lictor
 * session id で、 SessionStart hook (`lictor cli session-id-hook`) が hook payload の
 * `transcript_path` (= claude が実際に書き出している JSONL の絶対パス) を書き込む.
 *
 * transcript-tail はこれを権威ソースとして tail 対象を束縛する. これにより:
 *  - `--session-id` で渡した uuid と実 JSONL のファイル名 uuid が一致しなくても
 *    実ファイルを正しく掴める (中継不能の解消).
 *  - `/clear` 等で別 uuid の新 JSONL にローテートしても hook 再発火で新パスに
 *    更新されるので追従できる.
 *  - mtime 推測 discover を一切しないので、 並走する別セッションの JSONL を
 *    誤掴みする crosstalk が構造的に起きない.
 */
export function claudeTranscriptStatePath(stateDir: string, lictorSessionId: string): string {
  return join(stateDir, `claude-transcript-${lictorSessionId}.txt`);
}

/** {@link claudeTranscriptStatePath} の中身 (現 transcript JSONL 実パス) を読む. 無ければ null. */
export function readClaudeTranscriptPath(path: string): string | null {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v || null;
  } catch {
    return null; // 未作成 (SessionStart hook 未発火) / 読めない
  }
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
