import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_ROOT_PARTS = [".claude", "lictor", "sessions"];

/** Per-skill content cap (32 KiB). Skills are loaded into every claude turn. */
export const MAX_SKILL_BYTES = 32 * 1024;

/** Validate / normalize a skill name. Returns null when invalid. */
export function sanitizeSkillName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();
  // kebab-case, must start with a letter, max 64 chars.
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Manages a per-session directory of skills that claude picks up via
 * `--add-dir <sessionDir>`. Layout:
 *
 *   <sessionRoot>/<sessionId>/
 *     .claude/skills/<skill-name>/SKILL.md
 *
 * Claude's file watcher reloads SKILL.md edits live, but NEW skill
 * directories are only discovered at startup. So writeSkill() always
 * (re)creates the dir, accepting that mid-session adds need a restart
 * to be visible the first time around.
 */
export class SkillInjector {
  readonly sessionDir: string;
  readonly skillsDir: string;

  constructor(public readonly sessionId: string, root?: string) {
    const base = root ?? join(homedir(), ...SESSION_ROOT_PARTS);
    this.sessionDir = join(base, sessionId);
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
 * Wrap markdown content with the SKILL.md frontmatter claude expects.
 * `description` is what claude shows in the skill picker; keep it short.
 */
export function renderSkillMd(opts: {
  name: string;
  description: string;
  body: string;
}): string {
  const safeDesc = opts.description.replace(/\r?\n/g, " ").trim();
  return `---\nname: ${opts.name}\ndescription: ${safeDesc}\n---\n\n${opts.body.trim()}\n`;
}
