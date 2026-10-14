/**
 * Cc が決めた Codex の起動方針 (sandbox / node_repl / model) を codex の引数へ写す。
 *
 * Windows の Codex は sandbox=workspace-write / read-only だとシェル実行の準備
 * ("setup refresh had errors") に失敗し、モデルは Codex Desktop が config.toml に
 * 書き込んだ `node_repl` MCP へ退避する。 node_repl は env を引き継がない
 * (LICTOR_PORT が無い) ため、Cc への報告・local PR 提出の前で止まっていた
 * (2026-10-13 / 2026-10-14 の rollout で実測)。
 *
 * - sandbox は Cc が `LICTOR_CODEX_SANDBOX` で渡す。 未指定なら codex の設定どおり
 *   (人間が端末から起動したセッションの挙動を変えない)。
 * - Cc が sandbox を決めた起動では node_repl を外す。 ただし `-c mcp_servers.node_repl.*`
 *   は未定義の server に付けると codex が "invalid transport" で起動に失敗するので、
 *   config.toml に `[mcp_servers.node_repl]` があるときだけ付ける。
 * - App Server レーンは `--model` を受けないので `-c model=` に直して渡す。
 *
 * 純関数のみ。 config.toml の読み込みは呼び出し側が行う。
 */

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export const CODEX_SANDBOX_ENV = "LICTOR_CODEX_SANDBOX";

const SANDBOX_MODES: ReadonlySet<string> = new Set(["read-only", "workspace-write", "danger-full-access"]);

/** `LICTOR_CODEX_SANDBOX` を読む。 未設定は null、 不正値は起動前に止める。 */
export function codexSandboxFromEnv(env: NodeJS.ProcessEnv): CodexSandboxMode | null {
  const raw = env[CODEX_SANDBOX_ENV]?.trim();
  if (!raw) return null;
  if (!SANDBOX_MODES.has(raw)) {
    throw new Error(
      `invalid ${CODEX_SANDBOX_ENV}=${raw}; expected read-only, workspace-write or danger-full-access`,
    );
  }
  return raw as CodexSandboxMode;
}

/** 対話 (TUI / resume) の codex に付ける sandbox と承認方針。 */
export function codexSandboxArgs(sandbox: CodexSandboxMode | null): string[] {
  if (!sandbox) return [];
  // 枠なしは Satelles と同じく承認を求めない。 リレー越しに承認 picker へ答えられない。
  if (sandbox === "danger-full-access") {
    return ["--sandbox", sandbox, "--ask-for-approval", "never"];
  }
  return ["--sandbox", sandbox];
}

const NODE_REPL_TABLE_RE = /^\s*\[\s*mcp_servers\s*\.\s*(?:node_repl|"node_repl"|'node_repl')\s*\]\s*(?:#.*)?$/mu;

/** config.toml が `[mcp_servers.node_repl]` を宣言しているか。 */
export function configDeclaresNodeRepl(configText: string | null): boolean {
  if (!configText) return false;
  return NODE_REPL_TABLE_RE.test(configText);
}

/** Cc が sandbox を決めた起動だけ node_repl を外す引数。 */
export function nodeReplDisableArgs(
  sandbox: CodexSandboxMode | null,
  nodeReplDeclared: boolean,
): string[] {
  if (!sandbox || !nodeReplDeclared) return [];
  return ["-c", "mcp_servers.node_repl.enabled=false"];
}

/**
 * provider 引数のうち App Server が受けられるものを `-c` へ直す。
 * `--model X` / `-m X` / `--model=X` は `-c model="X"`、 `-c` / `--enable` / `--disable` はそのまま。
 * それ以外 (TUI 専用フラグや位置引数) は App Server に意味が無いので渡さない。
 */
export function codexAppServerConfigArgs(providerArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < providerArgs.length; i++) {
    const arg = providerArgs[i]!;
    const next = providerArgs[i + 1];
    if ((arg === "--model" || arg === "-m") && next !== undefined) {
      out.push("-c", `model=${JSON.stringify(next)}`);
      i++;
    } else if (arg.startsWith("--model=")) {
      out.push("-c", `model=${JSON.stringify(arg.slice("--model=".length))}`);
    } else if ((arg === "-c" || arg === "--config" || arg === "--enable" || arg === "--disable") && next !== undefined) {
      out.push(arg === "--config" ? "-c" : arg, next);
      i++;
    }
  }
  return out;
}
