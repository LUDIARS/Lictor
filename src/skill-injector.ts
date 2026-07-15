import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillStrategy } from "./provider.js";

const CLAUDE_SESSION_ROOT_PARTS = [".claude", "lictor", "sessions"];

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
 * Writes SKILL.md files into the session-scoped location Claude scans:
 *
 *   - `claude-add-dir`: `<homeRoot>/.claude/lictor/sessions/<sessionId>/.claude/skills/<name>/SKILL.md`
 *     (wrap.ts passes `--add-dir <sessionDir>` to claude).
 *   - `none`: instantiation throws — caller should branch on
 *     `provider.supportsSkills` before constructing.
 */
export class SkillInjector {
  readonly sessionDir: string;
  readonly skillsDir: string;
  readonly strategy: SkillStrategy;
  constructor(sessionId: string, strategy: SkillStrategy = "claude-add-dir", opts: SkillInjectorOptions = {}) {
    if (strategy === "none") {
      throw new Error("SkillInjector should not be constructed when provider.supportsSkills is false");
    }
    this.strategy = strategy;
    const home = opts.homeRoot ?? homedir();
    this.sessionDir = join(home, ...CLAUDE_SESSION_ROOT_PARTS, sessionId);
    this.skillsDir = join(this.sessionDir, ".claude", "skills");
    mkdirSync(this.skillsDir, { recursive: true });
  }

  writeSkill(rawName: string, content: string): void {
    const name = sanitizeSkillName(rawName);
    if (!name) throw new Error(`invalid skill name: ${JSON.stringify(rawName)}`);
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
      throw new Error(`skill ${name}: content exceeds ${MAX_SKILL_BYTES} bytes`);
    }
    const dir = join(this.skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  }

  deleteSkill(rawName: string): boolean {
    const name = sanitizeSkillName(rawName);
    if (!name) return false;
    const dir = join(this.skillsDir, name);
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
      return readdirSync(this.skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  cleanup(): void {
    try {
      rmSync(this.sessionDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Wrap markdown content with the SKILL.md frontmatter Claude Code expects.
 * `description` is what the skill picker / hint UI shows; keep it short.
 */
export function renderSkillMd(opts: {
  name: string;
  description: string;
  body: string;
}): string {
  const safeDesc = opts.description.replace(/\r?\n/g, " ").trim();
  return `---\nname: ${opts.name}\ndescription: ${safeDesc}\n---\n\n${opts.body.trim()}\n`;
}
