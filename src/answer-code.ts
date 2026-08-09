/**
 * Option codes (`[A]`, `[B]`, ...) for text answers to ask-marker questions.
 *
 * ## Why
 *
 * A question card is answered from three places: a Discord button, the Web UI,
 * or a plain text reply relayed into the session. The first two carry an
 * explicit option index; the text reply carries only prose. Without a marker in
 * the prose we cannot tell "I pick the second option" from free-form input, so
 * the card is shown with a short code per option and a reply may name one.
 *
 * Codes are an *affordance*, not a grammar: a reply with no code is still a
 * valid answer (the user may answer outside the offered options), it is simply
 * recorded as free text. Nothing here rejects input — parsing only decides
 * whether an answer can be attributed to specific options.
 */

import type { AskMarker } from "./ask-marker.js";
import type { AnswerQuestionBody } from "./ask-question-relay.js";

/** Concordia caps free-text answers at 2000 chars (`other_text` schema). */
const MAX_FREE_TEXT = 2000;

/** Letters used for option codes. 26 options is far beyond any real card. */
const CODE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** `0 → "A"`, `25 → "Z"`. Indices past Z get a 1-based number instead. */
export function formatOptionCode(index: number): string {
  if (!Number.isInteger(index) || index < 0) return "?";
  return index < CODE_LETTERS.length ? CODE_LETTERS[index]! : String(index + 1);
}

/**
 * Collect the option indices a reply names, in first-appearance order.
 *
 * Accepts `[A]`, `[a]`, `[A][C]` and `[A, C]` — the bracket is what makes it a
 * code, so ordinary prose that happens to contain the letter A is not a match.
 * Returns an empty array when the reply names nothing in range, which the
 * caller treats as a free-text answer.
 */
export function parseOptionCodes(text: string, optionCount: number): number[] {
  if (!text || optionCount <= 0) return [];
  const indices: number[] = [];
  for (const match of text.matchAll(/\[([A-Za-z0-9][A-Za-z0-9,\s]*)\]/g)) {
    for (const token of match[1]!.split(",")) {
      const index = codeToIndex(token.trim());
      if (index === null || index >= optionCount) continue;
      if (!indices.includes(index)) indices.push(index);
    }
  }
  return indices;
}

/**
 * Turn a typed reply into an answer payload for an open ask-marker question.
 *
 * @implements SPEC-ASK-MARKER-TEXT-ANSWER
 *
 * Option codes win when present, so "[B]" is recorded as *that option* rather
 * than as prose that happens to repeat the label. Everything else is kept
 * verbatim as a free-text answer — an answer outside the offered options is
 * legitimate, and dropping it is what made cards read "answered" with nothing
 * in them. Null only for an empty reply, which carries no answer at all.
 */
export function buildTextAnswerBody(
  questionId: number,
  reply: string,
  marker: AskMarker,
): AnswerQuestionBody | null {
  if (!reply) return null;
  const indices = parseOptionCodes(reply, marker.options.length);
  if (indices.length > 1 && marker.multiSelect) return { question_id: questionId, answer_indices: indices };
  if (indices.length >= 1) return { question_id: questionId, answer_index: indices[0]! };
  return { question_id: questionId, other_text: reply.slice(0, MAX_FREE_TEXT) };
}

/** `"A" → 0`, `"27" → 26`. Null when the token is not a code. */
function codeToIndex(token: string): number | null {
  if (/^[A-Za-z]$/.test(token)) return CODE_LETTERS.indexOf(token.toUpperCase());
  if (/^\d+$/.test(token)) {
    const ordinal = Number(token);
    return ordinal >= 1 ? ordinal - 1 : null;
  }
  return null;
}
