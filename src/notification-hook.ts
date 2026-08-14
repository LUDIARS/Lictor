/**
 * `lictor cli notification-hook` — Claude Code `Notification` hook bridge.
 *
 * なぜ PreToolUse ではなくここなのか:
 *   PreToolUse は **ツールを呼ぶたび** に発火するので、 そこで許可カードを出すと
 *   全コマンドでカードが出る (だから従来は封じられていた)。 Notification は
 *   **Claude が実際に人間の入力待ちで止まったとき** にしか発火しないので、
 *   settings.json や permission mode に関わらず「本当に許可が要るものだけ」 を
 *   選り分けられる。
 *
 * 安全弁: 出力は何も書かない (Notification hook に decision の概念は無い)。
 * LICTOR_PORT 無し / sidecar 不達 / 例外 → 何もせず exit 0。
 */

import { request } from "node:http";

interface HookInput {
  hook_event_name?: string;
  message?: unknown;
  cwd?: unknown;
  session_id?: unknown;
}

const POST_TIMEOUT_MS = 3000;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function postSidecar(port: number, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/internal/notification",
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

export async function runNotificationHook(): Promise<void> {
  const port = process.env.LICTOR_PORT ? Number(process.env.LICTOR_PORT) : NaN;
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.exit(0);
  }
  if (Number.isFinite(port) && port > 0) {
    await postSidecar(port, {
      message: input.message,
      cwd: input.cwd,
      claude_session_id: input.session_id,
    });
  }
  process.exit(0);
}
