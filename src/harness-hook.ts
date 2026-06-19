// Lictor が spawn する Claude セッションへ渡す PreToolUse hook 設定の組み立て。
//
// 既定の 2 フック (permission-hook / ask-question-hook) に加え、env
// LICTOR_HARNESS_GUARD が指す AIFormat の harness-guard.mjs を PreToolUse(Bash)
// として注入する。これにより委託先含む全セッションで「着手前に既知の地雷を止める」
// ガード (HARNESS §4) が効く。env 未設定 / ファイル不在なら注入しない (opt-in)。
//
// 純粋ロジックのみ (node-pty 等に依存しない) で、テスト可能に wrap.ts から分離。

import { existsSync } from "node:fs";

export interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
}
export interface HookMatcher {
  matcher: string;
  hooks: HookCommand[];
}
export interface LictorHookSettings {
  hooks: { PreToolUse: HookMatcher[] };
}

/**
 * harness-guard.mjs の絶対パスを解決する。env LICTOR_HARNESS_GUARD が指す実在
 * ファイルのみ採用する。未設定 / 不在なら null (= 注入しない)。
 */
export function resolveHarnessGuard(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const p = env.LICTOR_HARNESS_GUARD;
  if (p && p.trim() && existsSync(p)) return p;
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

  return { hooks: { PreToolUse: preToolUse } };
}
