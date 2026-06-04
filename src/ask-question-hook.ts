/**
 * `lictor cli ask-question-hook` — Claude Code PreToolUse hook bridge for
 * `AskUserQuestion`.
 *
 * なぜ必要か (タイミング問題):
 *   Claude Code は `AskUserQuestion` の `tool_use` 行を、 **picker を開いた瞬間
 *   ではなく回答が確定してターンが閉じた時** に session JSONL へ書く。 transcript-tail
 *   はその行を tail して Concordia に質問を流すため、 **回答後にしか** Discord へ
 *   出せず手遅れになる (= Discord から答えられない)。
 *
 *   PreToolUse hook は picker が開く前に `tool_input` を持って発火するので、 ここで
 *   sidecar 経由で質問を早期投稿する。 transcript-tail の遅延投稿は Concordia 側の
 *   冪等化 (同一 question は同じ question_id に収束) で重複しない。
 *
 * 安全弁:
 *   - 出力は **何も書かない** (decision JSON を出さない) → claude は通常どおり picker を
 *     開いて回答を待つ。 これは権限ゲートではない。
 *   - LICTOR_PORT 無し / sidecar 不達 / 例外 → 何もせず exit 0 (picker を止めない)。
 */

import { request } from "node:http";

interface HookInput {
  tool_name?: string;
  tool_input?: { questions?: unknown };
}

const POST_TIMEOUT_MS = 2000;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/** sidecar の /v1/internal/ask-question に questions を投げる (best-effort)。 */
async function postSidecar(port: number, questions: unknown): Promise<void> {
  const body = JSON.stringify({ questions });
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/internal/ask-question",
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

export async function runAskQuestionHook(): Promise<void> {
  const port = process.env.LICTOR_PORT ? Number(process.env.LICTOR_PORT) : NaN;
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.exit(0); // 不正 stdin → 何もしない
  }
  // AskUserQuestion 以外は対象外 (matcher で絞っているが二重防御)。
  if (input.tool_name === "AskUserQuestion" && Number.isFinite(port) && port > 0) {
    const questions = input.tool_input?.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      await postSidecar(port, questions);
    }
  }
  // decision を出さずに抜ける → claude は通常どおり picker を開く。
  process.exit(0);
}
