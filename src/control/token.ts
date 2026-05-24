import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const CONTROL_DIR = [".claude", "lictor"];
const TOKEN_FILE = "control.token";

export interface TokenLocation {
  dir: string;
  path: string;
}

export function tokenLocation(homeRoot: string = homedir()): TokenLocation {
  const dir = join(homeRoot, ...CONTROL_DIR);
  return { dir, path: join(dir, TOKEN_FILE) };
}

/**
 * Read the existing token, or generate + persist a new one. Returns the
 * 64-hex-char token string. On POSIX we chmod 600 so other local users
 * can't read it; on Windows the home dir's ACLs already limit access.
 */
export function ensureToken(homeRoot: string = homedir()): string {
  const loc = tokenLocation(homeRoot);
  if (existsSync(loc.path)) {
    const t = readFileSync(loc.path, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(t)) return t;
    // corrupt — rotate
  }
  mkdirSync(loc.dir, { recursive: true });
  const fresh = randomBytes(32).toString("hex");
  writeFileSync(loc.path, fresh, "utf8");
  if (platform() !== "win32") {
    try {
      chmodSync(loc.path, 0o600);
    } catch {
      // best-effort
    }
  }
  return fresh;
}

/** Read the token without generating one. Returns null if missing. */
export function readToken(homeRoot: string = homedir()): string | null {
  const loc = tokenLocation(homeRoot);
  try {
    if (!existsSync(loc.path)) return null;
    const t = readFileSync(loc.path, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison. Both inputs must be hex strings of the same
 * length; mismatched lengths or non-hex return false without short-circuit
 * to keep timing flat (defense in depth — the wire format already pins
 * length).
 */
export function tokenMatches(expected: string, provided: string): boolean {
  if (typeof provided !== "string") return false;
  if (provided.length !== expected.length) return false;
  let a: Buffer, b: Buffer;
  try {
    a = Buffer.from(expected, "hex");
    b = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Parse `Authorization: Bearer <token>` or `X-Lictor-Token: <token>` from
 * request headers. Returns the token string, or null if neither is set
 * or both are malformed.
 */
export function extractToken(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = pickHeader(headers, "authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const x = pickHeader(headers, "x-lictor-token");
  if (x) return x.trim();
  return null;
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  // Case-insensitive — node's http normalizes incoming requests to lowercase
  // already, but callers (tests, hand-built maps) may pass mixed-case keys.
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== target) continue;
    if (Array.isArray(v)) return v[0] ?? null;
    if (typeof v === "string") return v;
  }
  return null;
}
// Re-export dirname so tests can poke the layout without re-importing path.
export { dirname };
