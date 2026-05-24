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
 */

import { request } from "node:http";

interface HookInput {
  tool_name?: string;
  tool_input?: unknown;
  hook_event_name?: string;
}

interface DecisionReply {
  decision: "allow" | "deny" | "ask";
  reason?: string;
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
    timeout_ms: 60_000,
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
            const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as DecisionReply;
            if (j && (j.decision === "allow" || j.decision === "deny" || j.decision === "ask")) {
              resolve(j);
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
  let input: HookInput = {};
  try {
    input = JSON.parse(stdinRaw) as HookInput;
  } catch {
    // Malformed stdin — emit no decision (claude falls through).
    process.exit(0);
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
