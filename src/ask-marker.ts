/**
 * "Ask marker" — Lictor が制御する **テキストベースの質問プロトコル**。
 *
 * 背景: Claude Code の組み込み `AskUserQuestion` は対話 picker を描画し、
 * 答える手段がキーボードのみ。Lictor が pty でラップしているため、リモート
 * (Discord) からの回答は「キー注入」という fragile な手段に頼っていた。
 *
 * そこで picker を使わせず、モデルに **Lictor が決めたマーカー** で質問を
 * テキスト出力させる。Lictor は transcript からこのマーカーを構造化パースして
 * 既存の pending-question パイプライン (Discord カード) に流し、回答は
 * **通常のテキスト注入** で pty に返す。これで単一選択・複数選択・自由文が
 * すべて「テキスト返信」に一本化され、キー注入が不要になる。
 *
 * マーカー形式 (assistant のテキスト出力中に 1 ブロック):
 *
 *   ```ask
 *   {"question":"...","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}
 *   ```
 *
 * JSON なのでパースが確実で、AskUserQuestion のスキーマと同型のためモデルが
 * 自然に書ける。`writeAskMarkerPrompt` が起動時 system-prompt として注入する。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractOptions } from "./ask-question-relay.js";

export interface AskMarker {
  question: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

/**
 * **共通** (全 provider) のステアリング本文。「ユーザに選択肢を求めるときは ask
 * マーカーで質問しろ」。AskUserQuestion には触れない (Claude 固有なので addendum 側)。
 */
export const ASK_MARKER_COMMON = `# ユーザへの選択提示 (Lictor relay)

このセッションは Lictor にラップされ、リモート (Discord 等) から回答される可能性があります。対話 picker はリレー越しに回答できないため、ユーザに選択や判断を求めるときは次のテキストプロトコルを使ってください。

- 情報文字列 \`ask\` を付けたフェンスドコードブロックを**ちょうど1つ**出力し、JSON オブジェクトを1つ入れて、そのままターンを終了して返信を待ってください。形式:

\`\`\`ask
{"question":"<ユーザの言語での質問>","multiSelect":false,"options":[{"label":"<短いラベル>","description":"<任意の補足>"},{"label":"..."}]}
\`\`\`

- 複数選択を許す場合は "multiSelect": true にしてください。
- ユーザには常に暗黙の「その他 / 自由文」回答があります。"Other" を選択肢に足す必要はありません。自由文が妥当な場面ではそう促してください。
- ブロックを出したらターンを終了します。ユーザの次のメッセージ (ラベル / 複数ラベル / 自由文) が回答です。それに従って続行してください。
- 選択肢の無い純粋な自由質問は、ブロック無しで普通のテキストで尋ねてください。
- ラベルは短く、ニュアンスは "description" に入れてください。
`;

/** **Claude 固有** addendum。組み込み AskUserQuestion を封じて ask マーカーへ寄せる。 */
export const ASK_MARKER_CLAUDE_ADDENDUM = `
## ツールの注意 (Claude Code)

- 組み込みの AskUserQuestion ツールは**使わないでください**。代わりに上記の \`ask\` マーカーで質問してください。AskUserQuestion の対話 picker はリレー越しに回答できません。
`;

/** Claude の \`--append-system-prompt-file\` に渡す本文 (共通 + AskUserQuestion 禁止)。 */
export const ASK_MARKER_CLAUDE_SYSTEM_PROMPT = ASK_MARKER_COMMON + ASK_MARKER_CLAUDE_ADDENDUM;

/** Codex 等、skill 注入で共通ルールを配る provider 用の SKILL メタ + 本文 (共通のみ)。 */
export const ASK_MARKER_SKILL_NAME = "lictor-ask-marker";
export const ASK_MARKER_SKILL_DESCRIPTION =
  "ユーザに選択肢や判断を求めるときは ask マーカー (```ask + JSON) で質問する。Lictor がリモート回答に変換する。";
export const ASK_MARKER_SKILL_BODY = ASK_MARKER_COMMON;

/** Claude 用 ask マーカー system-prompt をセッションdirに書き、`--append-system-prompt-file` 用のパスを返す。 */
export function writeAskMarkerPrompt(sessionDir: string): string {
  const path = join(sessionDir, "ask-marker-system-prompt.txt");
  writeFileSync(path, ASK_MARKER_CLAUDE_SYSTEM_PROMPT, "utf8");
  return path;
}

/**
 * assistant のテキスト出力から ask マーカーブロックをパースする。
 * 1 行の transcript JSONL を受け取り、assistant の text を連結して走査する。
 * マーカーが無ければ null。
 */
export function detectAskMarker(line: string): AskMarker | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || msg.type !== "assistant") return null;
  const content = msg.message?.content;
  let text = "";
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") text += part.text + "\n";
    }
  } else if (typeof content === "string") {
    text = content;
  }
  if (!text) return null;
  return parseAskMarkerText(text);
}

/**
 * 生テキストから ```ask ... ``` ブロックを取り出してパースする純関数 (テスト容易性のため分離)。
 */
export function parseAskMarkerText(text: string): AskMarker | null {
  const m = /```ask[^\n]*\n([\s\S]*?)```/.exec(text);
  if (!m) return null;
  let obj: any;
  try {
    obj = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const question = typeof obj.question === "string" ? obj.question.trim() : "";
  if (!question) return null;
  const options = extractOptions(obj.options);
  if (options.length === 0) return null;
  return { question, multiSelect: obj.multiSelect === true, options };
}
