// Lictor が spawn する Claude セッションへ渡す PreToolUse hook 設定の組み立て。
//
// 既定の 2 フック (permission-hook / ask-question-hook) に加え、ワークスペース直下の
// AIFormat harness-guard.mjs を PreToolUse(Bash) として注入する。これにより委託先
// 含む全セッションで「着手前に既知の地雷を止める」ガード (HARNESS §4) が効く。
//
// フックの場所は env ではなく、セッション cwd から上位ディレクトリを辿って
// `.claude/hooks/harness-guard.mjs` を探して決定する (ワークスペース直下に在るため
// どのリポ配下からでも一意に解決できる)。見つからなければ注入しない。
//
// 純粋ロジックのみ (node-pty 等に依存しない) で、テスト可能に wrap.ts から分離。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
}
export interface HookMatcher {
  // SessionStart 等 matcher を取らない hook では省略する。
  matcher?: string;
  hooks: HookCommand[];
}
export interface LictorHookSettings {
  hooks: { PreToolUse: HookMatcher[]; SessionStart: HookMatcher[] };
}

const GUARD_REL = join(".claude", "hooks", "harness-guard.mjs");

/**
 * セッション cwd から上位へ辿り `.claude/hooks/harness-guard.mjs` を探す。
 * 最初に見つかった絶対パスを返す。無ければ null (= 注入しない)。
 */
export function resolveHarnessGuard(cwd: string): string | null {
  let dir = cwd;
  while (dir) {
    const cand = join(dir, GUARD_REL);
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break; // ルート到達
    dir = parent;
  }
  return null;
}

/**
 * Claude へ `--settings` で渡す hook 設定オブジェクトを組み立てる。
 * harnessGuard が非 null のとき PreToolUse(Bash) に harness-guard を足す。
 */
export function buildLictorHookSettings(
  harnessGuard: string | null,
): LictorHookSettings {
  const preToolUse: HookMatcher[] = [
    {
      // 書き込み系 + MCP を Lictor の権限ゲートに通す (Read/Glob/Grep は対象外)。
      matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
      hooks: [{ type: "command", command: "lictor cli permission-hook", timeout: 65 }],
    },
    {
      // AskUserQuestion を picker-open 時に検知して Concordia へ早期投稿する。
      matcher: "AskUserQuestion",
      hooks: [{ type: "command", command: "lictor cli ask-question-hook", timeout: 10 }],
    },
  ];

  if (harnessGuard) {
    // harness-guard は Bash のみを見て exit 2 で差し戻す (HARNESS §4 の地雷)。
    // パスは shell に渡るため forward-slash + quote に正規化する。
    const path = harnessGuard.replace(/\\/g, "/");
    preToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: `node "${path}"`, timeout: 10 }],
    });
  }

  // SessionStart: 起動 / `/clear` / resume / compact のたびに現 claude session_id を
  // state ファイルへ記録する。 transcript-tail が `/clear` 後の新 JSONL へ再 pin する
  // ための入力源 (matcher 無しで全 source に効かせる)。
  const sessionStart: HookMatcher[] = [
    {
      hooks: [{ type: "command", command: "lictor cli session-id-hook", timeout: 10 }],
    },
  ];

  return { hooks: { PreToolUse: preToolUse, SessionStart: sessionStart } };
}
