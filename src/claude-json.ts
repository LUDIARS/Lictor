/**
 * ~/.claude.json (Claude Code の設定ファイル) を Lictor が触るときの共通口。
 *
 * - パス解決: CLAUDE_CONFIG_DIR があればその下、無ければ home 直下。
 * - 読込: 無い / 壊れている / 期待する object 形状でない場合は null を返し、書き込ませない
 *   (壊れた設定をこちらの整形で上書きせず、claude 本体の自己修復に任せる)。
 * - project key: claude の新しめの entry と同じく forward slash。既存 entry の
 *   セパレータ表記ゆれ (E:/ と E:\) と Windows の大小文字差を同一視する。
 *
 * 書込みは read-modify-write で claude 本体と同じ流儀 (ロック無し)。呼び出し側は
 * claude が動いていない瞬間 (起動直前 / 終了後) に限って使う。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ClaudeJsonFs {
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
}

export const defaultClaudeJsonFs: ClaudeJsonFs = { existsSync, readFileSync, writeFileSync };

export interface ClaudeProjectEntry {
  hasTrustDialogAccepted?: boolean;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  [key: string]: unknown;
}

export interface ClaudeJsonDoc {
  root: { projects?: Record<string, ClaudeProjectEntry>; [key: string]: unknown };
  projects: Record<string, ClaudeProjectEntry>;
}

/**
 * claude が読む設定ファイルの場所。CLAUDE_CONFIG_DIR で動く claude (Concordia の相談) は
 * その下の .claude.json を読む。
 * @implements SPEC-WORKSPACE-TRUST-SEED
 */
export function resolveClaudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
}

/**
 * claude.json の project key 流儀 (新しめの entry は forward slash)。
 * @implements SPEC-WORKSPACE-TRUST-SEED
 */
export function normalizeProjectKey(path: string): string {
  return resolve(path).replace(/\\/g, "/");
}

/**
 * key 比較用の正規形。Windows はパスの大小文字を区別しない。
 * @implements SPEC-WORKSPACE-TRUST-SEED
 */
export function comparableProjectKey(key: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = key.replace(/\\/g, "/");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * 正規化済み key と同じ場所を指す既存 key を探す (無ければ undefined)。
 * @implements SPEC-WORKSPACE-TRUST-SEED
 */
export function findProjectKey(
  projects: Record<string, ClaudeProjectEntry>,
  normalizedKey: string,
): string | undefined {
  const target = comparableProjectKey(normalizedKey);
  return Object.keys(projects).find((key) => comparableProjectKey(key) === target);
}

/** entry が書き換えてよい object 形状か (undefined は「まだ無い」で可)。 */
export function isWritableEntry(entry: unknown): boolean {
  return entry === undefined || (!!entry && typeof entry === "object" && !Array.isArray(entry));
}

/**
 * claude.json を読み、projects を書き換えられる形で返す。書いてはいけない状態なら null。
 * projects が未定義なら空 object を補う (書くのは呼び出し側が変更したときだけ)。
 * @implements SPEC-WORKSPACE-TRUST-SEED
 */
export function loadClaudeJson(path: string, fsApi: ClaudeJsonFs = defaultClaudeJsonFs): ClaudeJsonDoc | null {
  if (!fsApi.existsSync(path)) return null;
  let root: ClaudeJsonDoc["root"];
  try {
    root = JSON.parse(fsApi.readFileSync(path, "utf8")) as ClaudeJsonDoc["root"];
  } catch {
    return null;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  if (root.projects !== undefined
    && (!root.projects || typeof root.projects !== "object" || Array.isArray(root.projects))) {
    return null;
  }
  const projects = (root.projects ??= {});
  return { root, projects };
}

/** loadClaudeJson で得た doc を書き戻す。 */
export function saveClaudeJson(path: string, doc: ClaudeJsonDoc, fsApi: ClaudeJsonFs = defaultClaudeJsonFs): void {
  fsApi.writeFileSync(path, JSON.stringify(doc.root), "utf8");
}
