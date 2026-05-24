/**
 * Provider abstraction — what binary to spawn, what features it supports.
 * Lictor v0.5 generalizes the wrapper from claude-only to any TUI agent
 * CLI that speaks a pty (currently: Claude Code, OpenAI Codex CLI).
 *
 * Feature flags are conservative: if a CLI doesn't support a mechanism
 * (e.g. Codex has no SKILL.md discovery), the corresponding lictor feature
 * downgrades to a no-op rather than breaking.
 */

export interface ProviderConfig {
  /** Identifier used in CLI: `lictor <name> [args...]`. */
  name: string;
  /** Binary to spawn. Resolved via PATH (with shell:true on Windows for .cmd). */
  binary: string;
  /**
   * If non-null, lictor will pass `<flag> <sessionSkillDir>` to the spawn args
   * so the CLI auto-loads skills from that dir. Only Claude Code supports this
   * for skill discovery (Codex's `--add-dir` exists but only widens the
   * writable sandbox — it does NOT trigger skill scanning).
   */
  skillDirFlag: string | null;
  /**
   * True only when `skillDirFlag` actually causes the CLI to load SKILL.md
   * files. Drives both the `seedSkills` call AND the sidecar's behavior
   * for /v1/skill (writes are no-ops when this is false).
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
    skillDirFlag: "--add-dir",
    supportsSkills: true,
    concordiaProvider: "claude-code",
    displayName: "Claude Code",
  },
  codex: {
    name: "codex",
    binary: "codex",
    // Codex CLI has `--add-dir` but it widens the writable sandbox; it does
    // NOT trigger skill-style discovery. Leave null until/unless Codex grows
    // a real equivalent.
    skillDirFlag: null,
    supportsSkills: false,
    concordiaProvider: "codex-cli",
    displayName: "OpenAI Codex",
  },
};

export function getProvider(name: string): ProviderConfig | null {
  return PROVIDERS[name] ?? null;
}
