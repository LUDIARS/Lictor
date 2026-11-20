import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AgyLaunch {
  logPath: string;
  spawnedAt: number;
  dispose(): void;
}

/** A private CLI log is proof of which conversation this particular PTY opened. */
export function prepareAgyLaunch(args: string[], env: NodeJS.ProcessEnv): AgyLaunch | null {
  const separator = args.indexOf("--");
  const flags = separator === -1 ? args : args.slice(0, separator);
  if (flags.some((arg) => /^--?log-file(?:=|$)/.test(arg))) return null;

  const dir = mkdtempSync(join(tmpdir(), "lictor-agy-"));
  const logPath = join(dir, "agy.log");
  args.unshift("--log-file=" + logPath);
  env.AGY_CLI_OSC7501 ??= "on";
  env.AGY_CLI_OSC7501_MESSAGES ??= "brief";
  return {
    logPath,
    spawnedAt: Date.now(),
    dispose() {
      try { unlinkSync(logPath); } catch { /* No log on failed spawn, or CLI still closing. */ }
      try { rmdirSync(dir); } catch { /* The process may still be closing its log. */ }
    },
  };
}

const OSC_PREFIX = "\x1b]7501;";
const OSC_FRAME = /\x1b\]7501;([^\x1b\x07]{0,256})(?:\x07|\x1b\\)/g;

export type AgyTerminalState = "working" | "done" | "error" | "idle" | "blocked";

/** Decode OSC 7501 status across PTY chunks without retaining TUI text. */
export class AgyTerminalStatus {
  private remainder = "";

  push(data: string, onState: (state: AgyTerminalState) => void): void {
    const input = this.remainder + data;
    let consumed = 0;
    for (const match of input.matchAll(OSC_FRAME)) {
      consumed = match.index + match[0].length;
      const properties = new URLSearchParams(match[1].replaceAll(":", "&"));
      const state = properties.get("state");
      if (properties.has("id")) continue; // The primary PTY state has no subagent id.
      if (state === "working" || state === "done" || state === "error" || state === "idle" || state === "blocked") {
        onState(state);
      }
    }
    const suffix = input.slice(Math.max(consumed, input.length - 270));
    const start = suffix.lastIndexOf(OSC_PREFIX);
    this.remainder = start >= 0 ? suffix.slice(start) : suffix.slice(-(OSC_PREFIX.length - 1));
  }
}
