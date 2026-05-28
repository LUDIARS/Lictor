/**
 * Relay Claude Code's `AskUserQuestion` tool invocations to Concordia's
 * `POST /v1/sessions/:id/pending-question` API, so the question can be
 * surfaced through Discord (or any other UI Concordia speaks).
 *
 * Why this lives outside transcript-tail's `lineToFrame`:
 *
 *  - `lineToFrame` is a pure converter (line → frame). Keeping it side-
 *    effect-free makes it trivially testable and reusable from non-tail
 *    contexts (e.g. Web UI replay).
 *  - The AskUserQuestion relay needs network access, a sessionId, and a
 *    fire-and-forget posture — it's an action, not a transform.
 *
 * Codex CLI does not expose an `AskUserQuestion` tool, so this module is
 * Claude-Code-shaped. Codex provider's rollout JSONL will simply never
 * trip the detector.
 */
import type { ProviderConfig } from "./provider.js";

const POST_TIMEOUT_MS = 2000;

export interface PendingQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
}

/**
 * Parse a single JSONL line from Claude Code's session log and return
 * **all** `AskUserQuestion` invocations found, as an array.
 *
 * Expected Claude shape:
 *
 *   {
 *     type: "assistant",
 *     message: {
 *       content: [
 *         {
 *           type: "tool_use",
 *           name: "AskUserQuestion",
 *           input: {
 *             questions: [
 *               {
 *                 question: "...",
 *                 options: [
 *                   { label: "...", description: "..." },
 *                   ...
 *                 ],
 *                 multiSelect: false,
 *                 ...
 *               },
 *               ...
 *             ]
 *           }
 *         }
 *       ]
 *     }
 *   }
 *
 * Returns an empty array when nothing matches. AskUserQuestion で渡された
 * `questions[]` 配列全部を返すので、 caller が一気に Discord に流せる.
 */
export function detectAskUserQuestion(line: string): PendingQuestion[] {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!msg || typeof msg !== "object") return [];
  if (msg.type !== "assistant") return [];

  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];

  const out: PendingQuestion[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "tool_use") continue;
    if (part.name !== "AskUserQuestion") continue;

    const questions = part.input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) continue;

    for (const q of questions) {
      if (!q || typeof q.question !== "string" || !q.question.trim()) continue;
      const options = extractOptions(q.options);
      if (options.length === 0) continue;
      out.push({ question: q.question, options });
    }
  }
  return out;
}

/**
 * Normalize `questions[i].options` into labeled options.
 *
 * Each option can be `{ label, description }` (the schema Claude documents)
 * or a bare string (some users pass a flat list). Empty / non-string labels
 * are dropped. Order is preserved so the answer-index → label mapping on
 * Concordia's side stays aligned.
 */
function extractOptions(raw: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; description?: string }> = [];
  for (const opt of raw) {
    if (typeof opt === "string") {
      const s = opt.trim();
      if (s) out.push({ label: s });
      continue;
    }
    if (opt && typeof opt === "object") {
      const label = (opt as { label?: unknown }).label;
      const description = (opt as { description?: unknown }).description;
      if (typeof label === "string" && label.trim()) {
        const normalized = label.trim();
        if (typeof description === "string" && description.trim()) {
          out.push({ label: normalized, description: description.trim() });
        } else {
          out.push({ label: normalized });
        }
      }
    }
  }
  return out;
}

/**
 * Fire-and-forget POST to Concordia. Errors are swallowed because this
 * sits inside a tight poll loop and a Concordia outage shouldn't slow
 * down or crash the wrapped CLI.
 */
export async function postPendingQuestion(
  baseUrl: string,
  sessionId: string,
  pq: PendingQuestion,
): Promise<void> {
  const url = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/pending-question`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: pq.question, options: pq.options }),
      signal: ctrl.signal,
    });
  } catch {
    // best-effort
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Should this provider's transcript be scanned for AskUserQuestion?
 * Codex CLI doesn't have this tool, so its rollout files are never going
 * to contain one — but checking by name keeps the call site uncluttered.
 */
export function providerSupportsAskUserQuestion(provider: ProviderConfig): boolean {
  return provider.name === "claude";
}
