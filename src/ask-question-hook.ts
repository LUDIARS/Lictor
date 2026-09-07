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
 *   - 既定では出力は **何も書かない** (decision JSON を出さない) → claude は通常どおり
 *     picker を開いて回答を待つ。
 *   - LICTOR_PORT 無し / sidecar 不達 / 例外 → 何もせず exit 0 (picker を止めない)。
 *
 * Cc spawn (`askUserQuestionDisabled`) のときだけ例外:
 *   picker は Lictor のリレー越しには回答できず、開いた時点でセッションが無言で
 *   停止する (2026-09-07 の lictor-2a7dc3e9)。 そこで **質問を Concordia へ流した直後に
 *   ツールを deny** し、picker を開かせない。 質問はユーザに届いており、回答は通常の
 *   ユーザメッセージとして pty に注入されるので、モデルはターンを閉じて待てばよい。
 *   deny の文面でそれを明示し、ask マーカーでの聞き直し (カード 2 枚) を防ぐ。
 */

import { request } from "node:http";

interface HookInput {
  tool_name?: string;
  tool_input?: { questions?: unknown };
}

/**
 * sidecar は deny 判定のため Concordia への投稿 (それ自体 2s timeout) を待ってから
 * 応答する。 ここを 2s にすると往復が先に切れて常に fail-open (picker が開く) に
 * なるので、 上流の timeout + ローカル往復ぶんの余裕を持たせる。
 */
const POST_TIMEOUT_MS = 4000;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/**
 * sidecar の /v1/internal/ask-question に questions を投げる (best-effort)。
 *
 * 応答の `ask_user_question_disabled` を返す。 true なら picker を開かせずに
 * deny する (質問自体は sidecar が Concordia へ流し終えている)。 sidecar 不達 /
 * 応答が壊れている場合は false = 従来どおり picker を開かせる (fail-open)。
 */
async function postSidecar(port: number, questions: unknown): Promise<boolean> {
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
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(readDisabledFlag(Buffer.concat(chunks).toString("utf8"))));
      },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(POST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

/** sidecar 応答から `ask_user_question_disabled` を読む (壊れていれば false)。 */
export function readDisabledFlag(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    return (parsed as { ask_user_question_disabled?: unknown }).ask_user_question_disabled === true;
  } catch {
    return false;
  }
}

/**
 * picker を開かせない PreToolUse 決定 (`permissionDecision: "deny"`)。
 *
 * 単に拒むと、 モデルは 「別の手段で聞き直そう」 として ask マーカーで同じことを
 * 質問し、 Concordia に質問カードが 2 枚出る。 既に送ってあること・回答が通常の
 * メッセージとして届くこと・だからターンを閉じて待てばよいことを明示する。
 */
export function buildAskQuestionDenyDecision(): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "このセッションでは AskUserQuestion の対話 picker は使えません "
        + "(Lictor のリレー越しには回答できないため)。"
        + "あなたの質問は Lictor が既に Concordia 経由でユーザへ送信済みです。"
        + "同じ内容を ask マーカーで聞き直さないでください。"
        + "回答は通常のユーザメッセージとして届くので、ここでターンを終えて待ってください。",
    },
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
      const disabled = await postSidecar(port, questions);
      if (disabled) {
        // 質問は sidecar が Concordia へ流し終えている。 picker だけを止める。
        process.stdout.write(buildAskQuestionDenyDecision());
        process.exit(0);
      }
    }
  }
  // decision を出さずに抜ける → claude は通常どおり picker を開く。
  process.exit(0);
}
