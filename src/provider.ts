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
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    name: "claude",
    binary: "claude",
    skillStrategy: "claude-add-dir",
    supportsSkills: true,
    concordiaProvider: "claude-code",
    displayName: "Claude Code",
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
  },
};

export function getProvider(name: string): ProviderConfig | null {
  return PROVIDERS[name] ?? null;
}
