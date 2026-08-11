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
 * ## 文頭のコードだけが回答 (2026-08-11)
 *
 * 以前は本文のどこかにコードがあれば回答、無ければ自由文の回答として記録していた。
 * その結果 **質問と無関係な発言 1 通でカードが閉じ、後から答えられない**。未回答の
 * 質問は blocker として残すのが正なので、回答と見なすのは **文頭に `[A]` を明示した
 * 返信だけ** に絞る。それ以外の本文はセッションには届くが、カードは開いたままで、
 * ボタン / WebUI / `answer-question` からいつでも答えられる。
 *
 * 文頭に限るのは ask リレーが壊れてカードを操作できないときの**避難口**として残す
 * ため — 人が明示的に `[A]` と書いたときだけ、その意思をテキストで受ける。
 */

import type { AskMarker } from "./ask-marker.js";
import type { AnswerQuestionBody } from "./ask-question-relay.js";

/** Letters accepted in bracketed option references. */
const CODE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Collect the option indices a reply names **at its very start**, in
 * first-appearance order.
 *
 * Accepts `[A]`, `[a]`, `[A][C]` and `[A, C]` — the bracket is what makes it a
 * code, so ordinary prose that happens to contain the letter A is not a match.
 * 走査は文頭の連続するコードブロックだけで打ち切る: 本文の途中に現れた `[B]`
 * (引用・ログの貼り付け等) を回答と誤読しないため。範囲外のコードしか無い返信は
 * 空配列を返し、呼び出し側は「回答ではない」として扱う。
 */
export function parseOptionCodes(text: string, optionCount: number): number[] {
  if (!text || optionCount <= 0) return [];
  const indices: number[] = [];
  let rest = text.trimStart();
  const leading = /^\[([A-Za-z0-9][A-Za-z0-9,\s]*)\]/;
  for (let match = leading.exec(rest); match; match = leading.exec(rest)) {
    for (const token of match[1]!.split(",")) {
      const index = codeToIndex(token.trim());
      if (index === null || index >= optionCount) continue;
      if (!indices.includes(index)) indices.push(index);
    }
    rest = rest.slice(match[0].length).trimStart();
  }
  return indices;
}

/**
 * Turn a typed reply into an answer payload for an open ask-marker question.
 *
 * @implements SPEC-ASK-MARKER-TEXT-ANSWER
 *
 * 文頭にオプションコードを明示した返信 (`[B] これで` 等) **だけ**が回答になる。
 * コードが無い返信は `null` — 質問は未回答の blocker のまま残り、ボタン / WebUI から
 * 改めて答えられる。本文そのものはセッションに届いているので、モデルはコード付き
 * 返信の後続テキスト (「[A] ただし条件付きで」) を通常の指示として読める。
 */
export function buildTextAnswerBody(
  questionId: number,
  reply: string,
  marker: AskMarker,
): AnswerQuestionBody | null {
  if (!reply) return null;
  const indices = parseOptionCodes(reply, marker.options.length);
  if (indices.length === 0) return null;
  if (indices.length > 1 && marker.multiSelect) return { question_id: questionId, answer_indices: indices };
  return { question_id: questionId, answer_index: indices[0]! };
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
