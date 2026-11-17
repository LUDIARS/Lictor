/**
 * Detached Cc spawn 用に、claude の初回 picker を起動前に潰す。
 *
 * claude は初回フォルダで (1) workspace trust picker、続けて (2) project MCP server
 * 承認 picker を出す。wrap.ts の画面キー自動承認はタイミング依存で打鍵を取りこぼす
 * ことがあり、claude 2.1.x は trust picker の既定が「❯ No, exit」のため、取りこぼし
 * = No 選択 = claude 即終了になる。
 *
 * ここでは spawn 前に `~/.claude.json` の projects[cwd] へ
 *   - hasTrustDialogAccepted: true (trust picker を出さない)
 *   - disabledMcpjsonServers: 未承認の project MCP server 名 (MCP picker を出さず実行もしない)
 * を焼く。画面キー承認 (wrap.ts) は文言変更時のフォールバックとして残す。
 *
 * 書込みは read-modify-write で claude 本体と同じ流儀 (ロック無し)。cwd の claude が
 * まだ起動していない spawn 直前に限って呼ぶことで競合窓を最小にする。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ClaudeJsonFs,
  defaultClaudeJsonFs,
  findProjectKey,
  isWritableEntry,
  loadClaudeJson,
  normalizeProjectKey,
  resolveClaudeJsonPath,
  saveClaudeJson,
} from "./claude-json.js";

export { normalizeProjectKey };

export interface WorkspaceTrustSeedResult {
  trustGranted: boolean;
  disabledServerCount: number;
}

export interface WorkspaceTrustSeedEligibility {
  hasRegisteredConcordiaSession: boolean;
  hasSpawnCredential: boolean;
  providerName: string;
}

/**
 * 永続 trust を書けるのは Cc enrollment 付きで登録された Claude spawn だけ。
 *
 * 「Cc が起動した無人 session」の判定に stdin の TTY 有無は使わない。Cc の
 * Windows Terminal tab は stdin が TTY でも picker に応答する人間がいない。TTY 条件で
 * 弾くと、未 trust の cwd で起動タスクの Enter 注入が既定の「No, exit」を
 * 選び、claude が終了する。登録済み session と enrollment (concordia_spawn_id) の
 * 組み合わせを Cc 起動の識別子とする。
 * @implements SPEC-WORKSPACE-TRUST-SEED
 */
export function shouldSeedWorkspaceTrust(opts: WorkspaceTrustSeedEligibility): boolean {
  return opts.hasRegisteredConcordiaSession
    && opts.hasSpawnCredential
    && opts.providerName === "claude";
}

/**
 * cwd から上位へ辿り、見つかった .mcp.json すべてのサーバ名を集める (claude の探索と同輪郭)。
 * @implements SPEC-WORKSPACE-TRUST-SEED
 */
export function collectMcpServerNames(
  cwd: string,
  fsApi: { existsSync: typeof existsSync; readFileSync: typeof readFileSync } = { existsSync, readFileSync },
): string[] {
  const names = new Set<string>();
  let current = resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(current, ".mcp.json");
    if (fsApi.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fsApi.readFileSync(candidate, "utf8")) as {
          mcpServers?: Record<string, unknown>;
        };
        const servers = parsed?.mcpServers;
        if (servers && typeof servers === "object" && !Array.isArray(servers)) {
          for (const name of Object.keys(servers)) names.add(name);
        }
      } catch {
        // 壊れた .mcp.json は claude 側も無視する。picker も出ないので何もしない。
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...names].sort();
}

/**
 * ~/.claude.json の projects[cwd] へ trust を焼き、未承認 project MCP は無効化する。
 * claude.json が無い環境 (claude 未初期化) では何もしない。
 * 変更が無ければ書き込まない。戻り値は実施内容 (未実施は null)。
 * @implements SPEC-WORKSPACE-TRUST-SEED
 */
export function seedWorkspaceTrust(opts: {
  cwd: string;
  claudeJsonPath?: string;
  fsApi?: ClaudeJsonFs;
}): WorkspaceTrustSeedResult | null {
  const fsApi = opts.fsApi ?? defaultClaudeJsonFs;
  const claudeJsonPath = opts.claudeJsonPath ?? resolveClaudeJsonPath();
  const doc = loadClaudeJson(claudeJsonPath, fsApi);
  if (!doc) return null;
  const { projects } = doc;

  // 既存 entry はセパレータ表記ゆれ (E:/ と E:\) の両方を探す。
  const normalized = normalizeProjectKey(opts.cwd);
  const projectKey = findProjectKey(projects, normalized) ?? normalized;
  if (!isWritableEntry(projects[projectKey])) return null;
  const entry = (projects[projectKey] ??= {});

  if ((entry.enabledMcpjsonServers !== undefined && !Array.isArray(entry.enabledMcpjsonServers))
    || (entry.disabledMcpjsonServers !== undefined && !Array.isArray(entry.disabledMcpjsonServers))) {
    return null;
  }
  if ((entry.enabledMcpjsonServers ?? []).some((name) => typeof name !== "string")
    || (entry.disabledMcpjsonServers ?? []).some((name) => typeof name !== "string")) {
    return null;
  }

  let changed = false;
  if (entry.hasTrustDialogAccepted !== true) {
    entry.hasTrustDialogAccepted = true;
    changed = true;
  }

  const disabled = new Set(entry.disabledMcpjsonServers ?? []);
  const enabled = new Set(entry.enabledMcpjsonServers ?? []);
  const disabledServers: string[] = [];
  for (const name of collectMcpServerNames(opts.cwd, fsApi)) {
    // project MCP は command を実行できる。人間が既に enable したものだけを維持し、
    // 未判断の server は detached session から暗黙に承認しない。
    if (disabled.has(name) || enabled.has(name)) continue;
    disabled.add(name);
    disabledServers.push(name);
    changed = true;
  }
  if (disabledServers.length > 0) entry.disabledMcpjsonServers = [...disabled];

  if (changed) {
    saveClaudeJson(claudeJsonPath, doc, fsApi);
  }
  return { trustGranted: true, disabledServerCount: disabledServers.length };
}
