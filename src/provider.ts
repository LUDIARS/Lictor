/**
 * Provider abstraction — what binary to spawn, what features it supports.
 * Lictor v0.5 generalizes the wrapper from claude-only to any TUI agent
 * CLI that speaks a pty (currently: Claude Code, OpenAI Codex CLI).
 *
 * Feature flags are conservative: if a CLI doesn't support a mechanism
 * (e.g. Codex has no SKILL.md discovery), the corresponding lictor feature
 * downgrades to a no-op rather than breaking.
 */

/**
 * How lictor delivers SKILL.md files to the wrapped CLI.
 *
 *  - `claude-add-dir`: write to `<sessionDir>/.claude/skills/<name>/SKILL.md`
 *    and pass `--add-dir <sessionDir>` to claude so it picks them up at scan.
 *    Session-scoped; cleanup removes the whole sessionDir.
 *
 *  - `codex-user-agents`: write to `~/.agents/skills/lictor-<sessionId>-<name>/SKILL.md`.
 *    Codex walks `$HOME/.agents/skills/` at startup (user scope) and
 *    hot-reloads SKILL.md edits, so no spawn arg is needed. The
 *    `lictor-<sessionId>-` prefix namespaces our writes so they can't
 *    collide with the user's own skills, and cleanup deletes them by
 *    prefix on session exit.
 *
 *  - `none`: provider has no SKILL.md discovery mechanism. seedSkills /
 *    /v1/skill endpoints become no-ops.
 */
export type SkillStrategy = "claude-add-dir" | "codex-user-agents" | "none";

export interface ProviderConfig {
  /** Identifier used in CLI: `lictor <name> [args...]`. */
  name: string;
  /** Binary to spawn. Resolved via PATH (with shell:true on Windows for .cmd). */
  binary: string;
  /**
   * Strategy for delivering SKILL.md files to the wrapped CLI. See
   * {@link SkillStrategy} for layout details. `none` disables skill
   * injection entirely for the provider.
   */
  skillStrategy: SkillStrategy;
  /**
   * Derived convenience: true iff `skillStrategy !== "none"`. Drives both
   * `seedSkills` invocation AND the sidecar `/v1/skill` behavior.
   */
  supportsSkills: boolean;
  /**
   * Value sent to Concordia POST /v1/sessions `provider` field.
   * Concordia distinguishes "claude-code" vs "codex-cli" for its dashboard.
   */
  concordiaProvider: string;
  /** Human-readable, used in startup banners + auto-title fallback. */
  displayName: string;
  /**
   * Concordia の session.inject 受信時に wrapped CLI へ「テキスト + submit キー」
   * をどう pty に書くかを provider 別に切り替えるための関数.
   *
   *  - claude: text と \r をまとめて 1 write — pty 上で 1 行の入力 + Enter として
   *    認識される (現行動作).
   *  - codex:  text と \r を分けて、 さらに微小 delay を挟む. codex CLI
   *    (crossterm + ratatui) は 1 chunk に text + \r があると \r を「入力 buffer
   *    への改行」として食ってしまい submit されないため.
   *
   * 引数の `write` は ptyWriter (= node-pty IPty.write). 戻り値は async でも
   * sync でもよい (呼び出し側は await しない fire-and-forget).
   */
  submitInject: (write: (data: string) => void, text: string) => void;
}

/**
 * 既定の単発書き戦略. text + \r を 1 chunk で pty に流す.
 * Claude Code / Gemini CLI 等、 「最終文字が \r なら Enter として認識する」 系の
 * TUI 向け.
 */
function submitInjectSingleWrite(write: (data: string) => void, text: string): void {
  write(text + "\r");
}

/**
 * Codex CLI 向け 2 段書き. text を流し → CODEX_INJECT_DELAY_MS だけ待ち →
 * \r だけを流す. crossterm の event loop が text 入力イベントと Enter キー
 * イベントを別物として認識してくれるよう間を空ける. delay は env override 可
 * (LICTOR_CODEX_INJECT_DELAY_MS, default 30).
 */
function submitInjectTwoStep(write: (data: string) => void, text: string): void {
  write(text);
  const delay = Number(process.env.LICTOR_CODEX_INJECT_DELAY_MS ?? "30");
  const ms = Number.isFinite(delay) && delay >= 0 ? delay : 30;
  setTimeout(() => write("\r"), ms);
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    name: "claude",
    binary: "claude",
    skillStrategy: "claude-add-dir",
    supportsSkills: true,
    concordiaProvider: "claude-code",
    displayName: "Claude Code",
    submitInject: submitInjectSingleWrite,
  },
  codex: {
    name: "codex",
    binary: "codex",
    // Codex Agent Skills (documented at developers.openai.com/codex/skills):
    // `.agents/skills/<name>/SKILL.md`. Repo / user / admin / system scopes.
    // We use the user scope (~/.agents/skills/) with a per-session prefix
    // so writes are auto-discovered without polluting the user's repo.
    skillStrategy: "codex-user-agents",
    supportsSkills: true,
    concordiaProvider: "codex-cli",
    displayName: "OpenAI Codex",
    submitInject: submitInjectTwoStep,
  },
  gemini: {
    name: "gemini",
    binary: "gemini",
    // Gemini CLI には現在 SKILL.md 相当の discovery 機構が無いので skill 注入は no-op.
    // pty / 端末タイトル / Concordia register / chat 経路 / transcript-tail などの
    // provider-agnostic 機能はそのまま動く.
    skillStrategy: "none",
    supportsSkills: false,
    concordiaProvider: "gemini-cli",
    displayName: "Gemini CLI",
    submitInject: submitInjectSingleWrite,
  },
};

export function getProvider(name: string): ProviderConfig | null {
  return PROVIDERS[name] ?? null;
}
