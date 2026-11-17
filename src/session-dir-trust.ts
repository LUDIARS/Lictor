/**
 * Lictor が claude へ `--add-dir` で渡すセッション用フォルダ
 * (`~/.claude/lictor/sessions/<sessionId>`) の workspace trust を起動前に登録する。
 *
 * claude (2.1.x) は追加フォルダごとに `projects[<正規化キー>].hasTrustDialogAccepted`
 * を完全一致で見る (親方向へは辿らない)。セッション用フォルダは毎回新しいので、
 * 登録しないと起動のたびに trust picker が出る。
 *
 * 対象は Lictor 自身が作った sessions 直下のフォルダに限る。cwd の trust と
 * eligibility (workspace-trust-seed.ts) には触れない。人間が端末から起動した場合も
 * 含めて登録してよいのは、中身が Lictor の書いた skill / hook 設定だけだから。
 *
 * 増え続けないように:
 *   - 終了時 (セッション用フォルダの片付け後) に自分の登録を外す。
 *   - 起動時に、sessions 直下で実フォルダが既に無い登録を掃除する
 *     (異常終了や、終了後に claude が設定を書き戻した分を回収する)。
 * sessions 外の登録 (人間が trust した既存 project) は読むだけで変えない。
 * @implements SPEC-SESSION-DIR-TRUST
 */

import {
  type ClaudeJsonFs,
  type ClaudeProjectEntry,
  defaultClaudeJsonFs,
  isWritableEntry,
  loadClaudeJson,
  normalizeProjectKey,
  resolveClaudeJsonPath,
  saveClaudeJson,
} from "./claude-json.js";
import { findSessionDirKey, isSessionDirKey } from "./session-dir-key.js";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:de972ae5 */
import augurContract_4b08e040 from './contracts/session-dir-trust.contract.js'; /* augur-inject:contract-predicate:051a20f7 */
import augurContract_530b3b95 from './contracts/session-dir-release.contract.js'; /* augur-inject:contract-predicate:f937beb5 */

export { findSessionDirKey, isSessionDirKey };

export interface SessionDirTrustOptions {
  /** `SkillInjector.sessionDir` */
  sessionDir: string;
  /** `SkillInjector.sessionsRoot` (`~/.claude/lictor/sessions`) */
  sessionsRoot: string;
  /** Override (tests). 既定は resolveClaudeJsonPath()。 */
  claudeJsonPath?: string;
  fsApi?: ClaudeJsonFs;
}

export interface SessionDirTrustSeedResult {
  trustGranted: boolean;
  prunedCount: number;
}

export interface SessionDirTrustReleaseResult {
  removed: boolean;
  prunedCount: number;
}

/**
 * sessions 直下の登録のうち、実フォルダが無いものを消す。keepKey は残す。
 * @implements SPEC-SESSION-DIR-TRUST
 */
function pruneStaleSessionEntries(
  projects: Record<string, ClaudeProjectEntry>,
  sessionsRoot: string,
  keepKey: string | undefined,
  fsApi: ClaudeJsonFs,
): number {
  let pruned = 0;
  for (const key of Object.keys(projects)) {
    if (key === keepKey || !isSessionDirKey(key, sessionsRoot)) continue;
    if (fsApi.existsSync(key)) continue;
    delete projects[key];
    pruned += 1;
  }
  return pruned;
}

/**
 * 起動前: セッション用フォルダを trust 済みとして登録し、消えたセッションの登録を掃除する。
 * sessions 直下でない / claude.json が無い・壊れている / 自 entry の形が想定外 なら何もせず null。
 * 変更が無ければ書き込まない。
 * @implements SPEC-SESSION-DIR-TRUST
 */
export function seedSessionDirTrust(opts: SessionDirTrustOptions): SessionDirTrustSeedResult | null {
  const own = normalizeProjectKey(opts.sessionDir);
  if (!isSessionDirKey(own, opts.sessionsRoot)) return null;
  const fsApi = opts.fsApi ?? defaultClaudeJsonFs;
  const claudeJsonPath = opts.claudeJsonPath ?? resolveClaudeJsonPath();
  const doc = loadClaudeJson(claudeJsonPath, fsApi);
  if (!doc) return null;
  const { projects } = doc;

  const ownKey = findSessionDirKey(projects, own) ?? own;
  if (!isWritableEntry(projects[ownKey])) return null;

  const prunedCount = pruneStaleSessionEntries(projects, opts.sessionsRoot, ownKey, fsApi);
  const entry = (projects[ownKey] ??= {});
  let changed = prunedCount > 0;
  if (entry.hasTrustDialogAccepted !== true) {
    entry.hasTrustDialogAccepted = true;
    changed = true;
  }
  if (changed) saveClaudeJson(claudeJsonPath, doc, fsApi);
  return { trustGranted: true, prunedCount };
}
// @ts-expect-error augur-inject
seedSessionDirTrust = contract(seedSessionDirTrust, { ...augurContract_4b08e040, contractId: 'C-6', mode: 'observe', sample: 1, where: 'src/session-dir-trust.ts:81', rule: 'contract-wrap', id: '4b08e040' }); /* augur-inject:contract-wrap:4b08e040 */

/**
 * 終了時: 自セッションの登録を外す (あわせて消えたセッションの登録も掃除する)。
 * sessions 直下でない / claude.json が無い・壊れている なら何もせず null。
 * @implements SPEC-SESSION-DIR-TRUST
 */
export function releaseSessionDirTrust(opts: SessionDirTrustOptions): SessionDirTrustReleaseResult | null {
  const own = normalizeProjectKey(opts.sessionDir);
  if (!isSessionDirKey(own, opts.sessionsRoot)) return null;
  const fsApi = opts.fsApi ?? defaultClaudeJsonFs;
  const claudeJsonPath = opts.claudeJsonPath ?? resolveClaudeJsonPath();
  const doc = loadClaudeJson(claudeJsonPath, fsApi);
  if (!doc) return null;
  const { projects } = doc;

  const ownKey = findSessionDirKey(projects, own);
  const removed = ownKey !== undefined;
  if (ownKey !== undefined) delete projects[ownKey];
  const prunedCount = pruneStaleSessionEntries(projects, opts.sessionsRoot, undefined, fsApi);
  if (removed || prunedCount > 0) saveClaudeJson(claudeJsonPath, doc, fsApi);
  return { removed, prunedCount };
}
// @ts-expect-error augur-inject
releaseSessionDirTrust = contract(releaseSessionDirTrust, { ...augurContract_530b3b95, contractId: 'C-7', mode: 'observe', sample: 1, where: 'src/session-dir-trust.ts:109', rule: 'contract-wrap', id: '530b3b95' }); /* augur-inject:contract-wrap:530b3b95 */
