/**
 * `lictor cli permission-hook` — Claude Code PreToolUse hook bridge.
 *
 * Spawned by claude per tool invocation when the per-session settings.json
 * (written at wrap startup) maps PreToolUse to this command. Reads the
 * standard hook input JSON on stdin, asks the local Lictor sidecar to
 * negotiate with Concordia's Web UI, then prints the claude-shaped
 * decision JSON on stdout.
 *
 * Exit codes follow Claude's contract:
 *   0  — success, parse stdout for `hookSpecificOutput.permissionDecision`
 *   2  — blocking error (we never emit this; deny goes via decision=deny)
 *
 * If LICTOR_PORT isn't set, or the sidecar is unreachable, we fall through
 * to claude's normal permission flow (no JSON on stdout) so the user
 * doesn't get stuck.
 *
 * The sidecar may also answer `{"deferred": true}`, which means "I have no
 * opinion, decide it yourself". That happens for self-processable requests:
 * this hook blocks the tool call while it runs, so the sidecar releases it
 * with zero added latency and observes the outcome asynchronously instead.
 */

import { request } from "node:http";
import { usesClaudeNativeAutoPermissions } from "./permission-mode.js";

interface HookInput {
  tool_name?: string;
  tool_input?: unknown;
  permission_mode?: unknown;
  guard_result?: unknown;
  hook_event_name?: string;
}

/** Raw sidecar reply for `/v1/internal/permission-check`. */
interface SidecarReply {
  decision?: "allow" | "deny" | "ask";
  /**
   * The sidecar classified this request as self-processable and released the
   * hook without an opinion. We must emit nothing so claude's own permission
   * engine handles it — the sidecar watches the outcome asynchronously.
   */
  deferred?: boolean;
  reason?: string;
}

/** A reply we actually forward to claude. */
interface DecisionReply {
  decision: "allow" | "deny" | "ask";
  reason?: string;
}

/** Return whether this hook must ask Lictor's coordinator for a decision. */
export function shouldProxyPermissionRequest(input: { permission_mode?: unknown }): boolean {
  return !usesClaudeNativeAutoPermissions(input.permission_mode);
}

function isHookInput(value: unknown): value is HookInput {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function askSidecar(port: number, input: HookInput): Promise<DecisionReply | null> {
  const body = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    permission_mode: input.permission_mode,
    guard_result: input.guard_result,
  });
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/internal/permission-check",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SidecarReply;
            if (j && j.deferred === true) {
              // Deferred: no decision on purpose, fall through to claude.
              resolve(null);
            } else if (j && (j.decision === "allow" || j.decision === "deny" || j.decision === "ask")) {
              resolve({ decision: j.decision, reason: j.reason });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

export async function runPermissionHook(): Promise<void> {
  const port = process.env.LICTOR_PORT ? Number(process.env.LICTOR_PORT) : NaN;
  const stdinRaw = await readStdin();
  let input: HookInput;
  try {
    const parsed: unknown = JSON.parse(stdinRaw);
    if (!isHookInput(parsed)) return;
    input = parsed;
  } catch {
    // Malformed stdin — emit no decision (claude falls through).
    process.exit(0);
  }
  if (!shouldProxyPermissionRequest(input)) {
    // Claude's auto mode can decide this request itself. Emitting any hook
    // decision here would replace that path with Lictor's coordinator wait.
    return;
  }
  if (!Number.isFinite(port) || port <= 0) {
    // No sidecar — emit no decision (claude falls through to its own perms).
    process.exit(0);
  }
  const reply = await askSidecar(port, input);
  if (!reply) {
    // Sidecar unreachable / error — emit no decision (claude falls through).
    process.exit(0);
  }
  // Emit the claude-shaped JSON on stdout.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: reply.decision,
      permissionDecisionReason: reply.reason ?? "",
    },
  }) + "\n");
  process.exit(0);
}
