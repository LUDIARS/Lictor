/**
 * `lictor cli permission-hook` — Claude Code PreToolUse hook bridge.
 *
 * Spawned by claude per tool invocation when the per-session settings.json
 * (written at wrap startup) maps PreToolUse to this command. Reads the
 * standard hook input JSON on stdin, hands it to the local Lictor sidecar as
 * an *observation*, and prints nothing.
 *
 * It deliberately never emits a permission decision. PreToolUse runs BEFORE
 * claude evaluates its own permission rules, so nothing here can tell whether
 * the call would have been auto-approved; deciding at this point put a
 * confirmation card in front of tool calls that settings.json already allowed
 * (observed on a non-auto session, 2026-08-14). The `Notification` hook is the
 * one signal that claude actually stopped for a human, so that is where cards
 * come from — see spec/feature/permission-proxy.md.
 *
 * The recorded observation is what the Notification hook later correlates
 * against (to name the command on the card) and what the audit trail is built
 * from.
 *
 * Exit code is always 0 and stdout is always empty: claude's own permission
 * engine stays authoritative, and a hook failure must never block a tool call.
 */

import { request } from "node:http";

interface HookInput {
  tool_name?: string;
  tool_input?: unknown;
  permission_mode?: unknown;
  guard_result?: unknown;
  hook_event_name?: string;
}

/** Sidecar round-trip is loopback-only; cap it so a wedged sidecar can't stall the tool. */
const POST_TIMEOUT_MS = 3000;

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

/** Record the attempted tool call with the sidecar. Best-effort by contract. */
async function recordWithSidecar(port: number, input: HookInput): Promise<void> {
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
        res.on("data", () => {});
        res.on("end", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.setTimeout(POST_TIMEOUT_MS, () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

export async function runPermissionHook(): Promise<void> {
  try {
    const port = process.env.LICTOR_PORT ? Number(process.env.LICTOR_PORT) : NaN;
    const stdinRaw = await readStdin();
    let input: HookInput | null = null;
    try {
      const parsed: unknown = JSON.parse(stdinRaw);
      if (isHookInput(parsed)) input = parsed;
    } catch {
      // Malformed stdin — nothing to record.
    }
    if (
      input &&
      typeof input.tool_name === "string" &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535
    ) {
      await recordWithSidecar(port, input);
    }
  } catch {
    // This hook is observation-only. Recording failures must not block the tool.
  }
  // No stdout: claude decides. No non-zero exit: a hook error must not block.
  process.exit(0);
}
