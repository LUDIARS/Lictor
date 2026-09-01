/**
 * `lictor cli send-file-hook` — Claude Code `PostToolUse` hook bridge for `SendUserFile`.
 *
 * なぜ PostToolUse なのか:
 *   ファイルの中継はツールが実際に成功してから行いたい。 PreToolUse だと
 *   まだ配送されていない (失敗するかもしれない) 段階で Discord へ流れる。
 *   PostToolUse は tool_input を保ったまま実行後に発火するので、ここで拾う。
 *
 * 安全弁: 出力は何も書かない (PostToolUse に decision の概念は無い)。
 * LICTOR_PORT 無し / sidecar 不達 / 例外 → 何もせず exit 0。
 */

import { request } from "node:http";
import { extractSendFileRelay } from "./send-file-relay.js";

const POST_TIMEOUT_MS = 15000;
const MAX_STDIN_BYTES = 64 * 1024;

async function readStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    process.stdin.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_STDIN_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    process.stdin.on("end", () => {
      resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => resolve(null));
  });
}

/** sidecar の /v1/internal/send-file に中継対象を投げる (best-effort)。 */
async function postSidecar(port: number, payload: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/internal/send-file",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": body.byteLength },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
        res.on("error", () => resolve());
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

export async function runSendFileHook(): Promise<void> {
  const port = process.env.LICTOR_PORT ? Number(process.env.LICTOR_PORT) : NaN;
  const raw = await readStdin();
  if (raw === null) process.exit(0);
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // 不正 stdin → 何もしない
  }
  const relay = extractSendFileRelay(input);
  if (relay && Number.isInteger(port) && port > 0 && port <= 65535) {
    await postSidecar(port, relay);
  }
  process.exit(0);
}
