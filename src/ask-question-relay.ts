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
  options: string[];
}

/**
 * Parse a single JSONL line from Claude Code's session log and return
 * the first `AskUserQuestion` invocation found, or `null` if there is none.
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
 *               }
 *             ]
 *           }
 *         }
 *       ]
 *     }
 *   }
 *
 * If the tool was invoked with multiple `questions[]` entries (multi-prompt),
 * only the first one is relayed for v0. Concordia / Discord can later add
 * batched picker UIs.
 */
export function detectAskUserQuestion(line: string): PendingQuestion | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  if (msg.type !== "assistant") return null;

  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "tool_use") continue;
    if (part.name !== "AskUserQuestion") continue;

    const questions = part.input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) continue;

    const q0 = questions[0];
    if (!q0 || typeof q0.question !== "string" || !q0.question.trim()) continue;

    const options = extractOptionLabels(q0.options);
    if (options.length === 0) continue;

    return { question: q0.question, options };
  }
  return null;
}

/**
 * Normalize `questions[i].options` into a string array of labels.
 *
 * Each option can be `{ label, description }` (the schema Claude documents)
 * or a bare string (some users pass a flat list). Empty / non-string labels
 * are dropped. Order is preserved so the answer-index → label mapping on
 * Concordia's side stays aligned.
 */
function extractOptionLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const opt of raw) {
    if (typeof opt === "string") {
      const s = opt.trim();
      if (s) out.push(s);
      continue;
    }
    if (opt && typeof opt === "object") {
      const label = (opt as { label?: unknown }).label;
      if (typeof label === "string" && label.trim()) {
        out.push(label.trim());
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
