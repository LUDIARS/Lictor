/**
 * Cwd-confined filesystem RPC. Concordia's Web UI proxies through these so
 * the user can inspect what a wrapped claude session is doing on disk
 * without SSH'ing into the host.
 *
 * Trust boundary: every operation goes through `resolveSafe(cwd, p)` which
 * normalizes the path and refuses anything that escapes cwd. Paths are
 * also rejected if they contain null bytes or are absolute on input
 * (callers must pass relative paths from cwd; we generate the absolute
 * one ourselves).
 *
 * No ripgrep / difftastic binaries. Grep is a naive recursive scan with a
 * 100-result cap. Read tops out at 256 KiB. Listing tops out at 1000
 * entries. Numbers are deliberately conservative — bigger needs should
 * use a real tool, not a Web UI panel.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";

const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 1000;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILES = 5000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "target"]);

export interface FsError { error: string }

function isFsError<T>(x: T | FsError): x is FsError {
  return typeof x === "object" && x !== null && "error" in x;
}

export function resolveSafe(cwd: string, p: string): string | FsError {
  if (typeof p !== "string") return { error: "path required" };
  if (p.includes("\0")) return { error: "null byte in path" };
  if (isAbsolute(p)) return { error: "absolute path not allowed; pass relative from cwd" };
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: "path escapes cwd" };
  return abs;
}

export interface ReadResult { path: string; bytes: number; truncated: boolean; content: string }

export function fsRead(cwd: string, p: string): ReadResult | FsError {
  const safe = resolveSafe(cwd, p);
  if (isFsError(safe)) return safe;
  let buf: Buffer;
  try {
    buf = readFileSync(safe);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const truncated = buf.length > MAX_READ_BYTES;
  const content = (truncated ? buf.subarray(0, MAX_READ_BYTES) : buf).toString("utf8");
  return { path: relative(cwd, safe), bytes: buf.length, truncated, content };
}

export interface ListEntry { name: string; is_dir: boolean; size: number | null }
export interface ListResult { path: string; entries: ListEntry[]; truncated: boolean }

export function fsList(cwd: string, p: string): ListResult | FsError {
  const safe = resolveSafe(cwd, p);
  if (isFsError(safe)) return safe;
  let dirents: Dirent[];
  try {
    dirents = readdirSync(safe, { withFileTypes: true });
  } catch (err) {
    return { error: (err as Error).message };
  }
  const truncated = dirents.length > MAX_LIST_ENTRIES;
  const slice = dirents.slice(0, MAX_LIST_ENTRIES);
  const entries: ListEntry[] = slice.map((d) => {
    let size: number | null = null;
    if (d.isFile()) {
      try { size = statSync(join(safe, d.name)).size; } catch { size = null; }
    }
    return { name: d.name, is_dir: d.isDirectory(), size };
  });
  // Directories first, then alphabetical — mirrors most file explorers.
  entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: relative(cwd, safe) || ".", entries, truncated };
}

export interface GrepHit { file: string; line: number; text: string }
export interface GrepResult { hits: GrepHit[]; files_scanned: number; truncated: boolean }

/**
 * Naive recursive grep — pure JS, no spawn. Suitable for small-to-medium
 * repos; for huge codebases the user should fall back to a terminal.
 * Skips well-known noise dirs (node_modules, .git, dist, ...).
 */
export function fsGrep(cwd: string, pattern: string, opts: { path?: string; flags?: string } = {}): GrepResult | FsError {
  if (!pattern || pattern.length > 1000) return { error: "pattern required, ≤ 1000 chars" };
  // g / y は lastIndex を持ち re.test() が stateful になって行を取りこぼすため、
  // stateless な flag のみ許可する (allowlist)。
  const flags = opts.flags ?? "";
  if (!/^[imsu]*$/.test(flags)) {
    return { error: `unsupported regex flags: "${flags}" (allowed: i, m, s, u)` };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    return { error: `invalid regex: ${(err as Error).message}` };
  }
  const startRel = opts.path && opts.path.length > 0 ? opts.path : ".";
  const start = resolveSafe(cwd, startRel);
  if (isFsError(start)) return start;

  const hits: GrepHit[] = [];
  let filesScanned = 0;
  let truncated = false;
  const stack: string[] = [start];
  while (stack.length > 0 && hits.length < MAX_GREP_MATCHES && filesScanned < MAX_GREP_FILES) {
    const dir = stack.pop()!;
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        stack.push(join(dir, d.name));
        continue;
      }
      if (!d.isFile()) continue;
      filesScanned++;
      const fp = join(dir, d.name);
      let buf: Buffer;
      try {
        const st = statSync(fp);
        if (st.size > 1_000_000) continue; // skip > 1 MiB
        buf = readFileSync(fp);
      } catch {
        continue;
      }
      // Binary-ish: skip if NUL byte in first 1024 bytes
      if (buf.subarray(0, 1024).includes(0)) continue;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({ file: relative(cwd, fp), line: i + 1, text: lines[i].slice(0, 400) });
          if (hits.length >= MAX_GREP_MATCHES) { truncated = true; break; }
        }
      }
      if (hits.length >= MAX_GREP_MATCHES) break;
    }
  }
  if (filesScanned >= MAX_GREP_FILES) truncated = true;
  return { hits, files_scanned: filesScanned, truncated };
}
