import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/**
 * Spawn modes for `POST /v1/spawn`.
 *   - `tab`:    new tab in the active Windows Terminal window
 *   - `window`: new Windows Terminal window
 *
 * Background mode is intentionally not supported in v0.5 — the claude TUI
 * needs an attached terminal to render.
 */
export type SpawnMode = "tab" | "window";

export interface SpawnRequest {
  provider: "claude" | "codex";
  args?: string[];
  cwd?: string;
  mode?: SpawnMode;
  title?: string;
  /** Extra env to merge into the spawned process. */
  env?: Record<string, string>;
}

export interface SpawnResult {
  ok: true;
  command: string[];
  pid: number | null;
}

/**
 * Build the wt.exe argument vector for a spawn request. Pure / synchronous
 * so it's easy to unit-test the exact CLI we'll emit.
 *
 *   tab:    wt --window 0 new-tab [--title <t>] [-d <cwd>] cmd /d /s /c lictor <provider> <args...>
 *   window: wt --window new new-tab [--title <t>] [-d <cwd>] cmd /d /s /c lictor <provider> <args...>
 *
 * Note: the leading `wt` is omitted — caller spawns wt.exe as the program
 * and passes this array as argv.
 */
export function buildWtArgs(req: SpawnRequest): string[] {
  const args: string[] = [];
  if (req.mode === "window") {
    args.push("--window", "new");
  } else {
    args.push("--window", "0");
  }
  args.push("new-tab");
  if (req.title) args.push("--title", req.title);
  if (req.cwd) args.push("-d", req.cwd);

  // The actual command. cmd.exe is required so PATH resolves `lictor.cmd`.
  args.push("cmd.exe", "/d", "/s", "/c", "lictor", req.provider);
  if (req.args && req.args.length > 0) args.push(...req.args);
  return args;
}

/**
 * Validate that a cwd, if supplied, refers to an existing directory.
 * Returns an error message or null when OK. (We don't auto-mkdir — that
 * would mask typos.)
 */
export function validateCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  try {
    if (!existsSync(cwd)) return `cwd does not exist: ${cwd}`;
    if (!statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`;
    return null;
  } catch (err) {
    return `cwd check failed: ${(err as Error).message}`;
  }
}

/**
 * Actually spawn wt.exe. On non-Windows hosts this returns an error result
 * synchronously — v0.5 is Windows-only by design (the wt.exe binary is the
 * portable launcher we depend on).
 */
export function spawnSession(req: SpawnRequest): SpawnResult | { ok: false; error: string } {
  if (process.platform !== "win32") {
    return { ok: false, error: "control Lictor spawn currently requires Windows + Windows Terminal" };
  }
  const cwdErr = validateCwd(req.cwd);
  if (cwdErr) return { ok: false, error: cwdErr };

  const args = buildWtArgs(req);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(req.env ?? {}) };
  // detached + unref so the child outlives us cleanly. We do not pipe stdio —
  // the wt.exe handoff is fire-and-forget (the new tab becomes its own process).
  const child = spawn("wt.exe", args, {
    detached: true,
    stdio: "ignore",
    env,
    windowsHide: false,
  });
  try {
    child.unref();
  } catch {
    // best-effort
  }
  return { ok: true, command: ["wt.exe", ...args], pid: child.pid ?? null };
}
