import { basename } from "node:path";
import type { RepoStat } from "./stat.js";
import type { ConcordiaPersona } from "./concordia-types.js";

/**
 * Build a default terminal title from session state.
 *
 * Format: `[<personaShort>] <repoLeaf> · <branch>` (omit segments that are
 * missing). Manual overrides via POST /v1/title win over auto until cleared.
 */
export function buildAutoTitle(opts: {
  persona: ConcordiaPersona | null;
  roleLabel: string | null;
  stat: RepoStat | null;
  cwd: string;
}): string {
  const segments: string[] = [];

  const personaTag = personaShort(opts.persona, opts.roleLabel);
  if (personaTag) segments.push(`[${personaTag}]`);

  const repoLeaf =
    opts.stat?.repo_path && opts.stat.repo_path !== ""
      ? basename(opts.stat.repo_path)
      : basename(opts.cwd || "");
  if (repoLeaf) segments.push(repoLeaf);

  if (opts.stat?.branch && opts.stat.branch !== "HEAD") {
    segments.push(`· ${opts.stat.branch}`);
  }

  if (opts.stat) {
    const marks: string[] = [];
    if (opts.stat.dirty) marks.push("●");
    if (opts.stat.unpushed_count > 0) marks.push(`↑${opts.stat.unpushed_count}`);
    if (marks.length > 0) segments.push(marks.join(""));
  }

  return segments.join(" ").trim();
}

function personaShort(
  persona: ConcordiaPersona | null,
  roleLabel: string | null,
): string | null {
  // roleLabel typically already follows "<ロール> / <名前>" — use that whole
  // string, capped to ~24 chars so a chatty persona doesn't blow the title.
  if (roleLabel) return clip(roleLabel, 24);
  if (persona?.name) return clip(String(persona.name), 24);
  if (persona?.role) return clip(String(persona.role), 24);
  return null;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}
