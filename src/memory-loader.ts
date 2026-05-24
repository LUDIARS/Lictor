import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface MatchedMemory {
  filename: string;
  score: number;
  body: string;
}

/**
 * Encode an absolute cwd to the directory name claude uses under
 * `~/.claude/projects/`. Replaces `:`, `\`, `/` with `-`.
 *
 *   E:\Document\Ars  →  E--Document-Ars
 */
export function cwdToProjectKey(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
}

export function memoryDirForCwd(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwdToProjectKey(cwd), "memory");
}

/**
 * Heuristic: find memories that mention the repo (cwd basename). Scoring:
 *   - +3  if the repo name appears in the memory's filename
 *   - +1  per occurrence in the body, capped at 3
 *
 * Returns the top `limit` matches by score, omitting MEMORY.md itself
 * (the index is already loaded for every claude session).
 */
export function findRepoMemories(
  memoryDir: string,
  repoLeaf: string,
  limit = 3,
): MatchedMemory[] {
  if (!repoLeaf || !existsSync(memoryDir)) return [];

  let files: string[];
  try {
    files = readdirSync(memoryDir).filter(
      (f) => f.endsWith(".md") && f.toLowerCase() !== "memory.md",
    );
  } catch {
    return [];
  }

  const needle = repoLeaf.toLowerCase();
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const occRe = new RegExp(escaped, "gi");

  const matches: MatchedMemory[] = [];
  for (const f of files) {
    let body: string;
    try {
      body = readFileSync(join(memoryDir, f), "utf8");
    } catch {
      continue;
    }
    let score = 0;
    if (f.toLowerCase().includes(needle)) score += 3;
    const bodyMatches = body.match(occRe);
    if (bodyMatches) score += Math.min(bodyMatches.length, 3);
    if (score > 0) matches.push({ filename: f, score, body });
  }

  matches.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
  return matches.slice(0, limit);
}

/**
 * Bundle matched memories into a single SKILL.md body. Caps total at
 * `maxBytes` so a memory-heavy repo doesn't blow the skill size limit.
 */
export function renderMemoryDigest(matches: MatchedMemory[], maxBytes = 8 * 1024): string {
  if (matches.length === 0) return "";
  const header =
    "Repo-relevant memories matched by the lictor wrapper at session start.\n" +
    "These are user notes, not authoritative — verify against current code.\n\n";
  let acc = header;
  for (const m of matches) {
    const block = `## ${m.filename}\n\n${m.body.trim()}\n\n---\n\n`;
    if (Buffer.byteLength(acc + block, "utf8") > maxBytes) {
      acc += `_(${matches.length - matches.indexOf(m)} more matches omitted for size cap.)_\n`;
      break;
    }
    acc += block;
  }
  return acc;
}

export function repoLeafFromCwd(cwd: string): string {
  // basename handles both / and \ on Windows.
  return basename(cwd) || cwd;
}
