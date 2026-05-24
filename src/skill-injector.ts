import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillStrategy } from "./provider.js";

const CLAUDE_SESSION_ROOT_PARTS = [".claude", "lictor", "sessions"];
const CODEX_USER_SKILLS_PARTS = [".agents", "skills"];

/** Per-skill content cap (32 KiB). Skills are loaded into every turn. */
export const MAX_SKILL_BYTES = 32 * 1024;

/** Validate / normalize a skill name. Returns null when invalid. */
export function sanitizeSkillName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();
  // kebab-case, must start with a letter, max 64 chars.
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(trimmed)) return null;
  return trimmed;
}

export interface SkillInjectorOptions {
  /** Override the home dir (tests). */
  homeRoot?: string;
}

/**
 * Writes SKILL.md files into the location the wrapped provider scans:
 *
 *   - `claude-add-dir`: `<homeRoot>/.claude/lictor/sessions/<sessionId>/.claude/skills/<name>/SKILL.md`
 *     (wrap.ts passes `--add-dir <sessionDir>` to claude).
 *   - `codex-user-agents`: `<homeRoot>/.agents/skills/lictor-<sessionId>-<name>/SKILL.md`
 *     (codex auto-walks the user scope; the lictor-<sessionId>- prefix scopes
 *     our writes to this session so cleanup can delete by prefix without
 *     touching the user's own skills).
 *   - `none`: instantiation throws — caller should branch on
 *     `provider.supportsSkills` before constructing.
 */
export class SkillInjector {
  readonly sessionDir: string;
  readonly skillsDir: string;
  readonly strategy: SkillStrategy;
  private readonly sessionId: string;
  /** When true, writeSkill prefixes the skill dir name (codex scope sharing). */
  private readonly prefixSkillName: boolean;

  constructor(sessionId: string, strategy: SkillStrategy = "claude-add-dir", opts: SkillInjectorOptions = {}) {
    if (strategy === "none") {
      throw new Error("SkillInjector should not be constructed when provider.supportsSkills is false");
    }
    this.sessionId = sessionId;
    this.strategy = strategy;
    const home = opts.homeRoot ?? homedir();
    if (strategy === "claude-add-dir") {
      this.sessionDir = join(home, ...CLAUDE_SESSION_ROOT_PARTS, sessionId);
      this.skillsDir = join(this.sessionDir, ".claude", "skills");
      this.prefixSkillName = false;
    } else {
      // codex-user-agents — the "session dir" is the user-scope skills root
      // itself; we don't own that whole dir, so cleanup is per-skill-name.
      this.skillsDir = join(home, ...CODEX_USER_SKILLS_PARTS);
      this.sessionDir = this.skillsDir;
      this.prefixSkillName = true;
    }
    mkdirSync(this.skillsDir, { recursive: true });
  }

  /** Skill-dir name on disk (after applying the codex per-session prefix). */
  private diskName(name: string): string {
    return this.prefixSkillName ? `lictor-${this.sessionId}-${name}` : name;
  }

  writeSkill(rawName: string, content: string): void {
    const name = sanitizeSkillName(rawName);
    if (!name) throw new Error(`invalid skill name: ${JSON.stringify(rawName)}`);
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
      throw new Error(`skill ${name}: content exceeds ${MAX_SKILL_BYTES} bytes`);
    }
    const dir = join(this.skillsDir, this.diskName(name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  }

  deleteSkill(rawName: string): boolean {
    const name = sanitizeSkillName(rawName);
    if (!name) return false;
    const dir = join(this.skillsDir, this.diskName(name));
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Logical skill names this session has written (prefix stripped for codex). */
  list(): string[] {
    try {
      const entries = readdirSync(this.skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      if (this.prefixSkillName) {
        const prefix = `lictor-${this.sessionId}-`;
        return entries
          .filter((n) => n.startsWith(prefix))
          .map((n) => n.slice(prefix.length))
          .sort();
      }
      return entries.sort();
    } catch {
      return [];
    }
  }

  cleanup(): void {
    if (this.strategy === "claude-add-dir") {
      // Owns the whole sessionDir — wipe it.
      try {
        rmSync(this.sessionDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      return;
    }
    // codex-user-agents — only delete our prefixed skill dirs.
    if (!existsSync(this.skillsDir)) return;
    const prefix = `lictor-${this.sessionId}-`;
    let entries: string[];
    try {
      entries = readdirSync(this.skillsDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      try {
        rmSync(join(this.skillsDir, name), { recursive: true, force: true });
      } catch {
        // best-effort per-skill
      }
    }
  }
}

/**
 * Wrap markdown content with the SKILL.md frontmatter both Claude Code
 * and Codex expect. `description` is what each agent shows in the skill
 * picker / hint UI; keep it short.
 */
export function renderSkillMd(opts: {
  name: string;
  description: string;
  body: string;
}): string {
  const safeDesc = opts.description.replace(/\r?\n/g, " ").trim();
  return `---\nname: ${opts.name}\ndescription: ${safeDesc}\n---\n\n${opts.body.trim()}\n`;
}
