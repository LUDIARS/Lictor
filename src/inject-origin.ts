/**
 * inject の **出どころ** を Concordia の `source` 文字列から分類する。
 *
 * ## なぜ要るか
 *
 * 未回答の ask マーカー質問が開いている間、pty へ流し込んで良い inject と、答えが
 * 返るまで待つべき inject がある。
 *
 *  - **human** (`discord:<uid>:…` / `slack:<uid>:…`) — その場に人が居る証拠。質問が
 *    開いていても本文はそのまま届けたい (会話まで止める必要は無い)。
 *  - **lifecycle** (`auto:session-end`) — 人が `/end-session` を叩いた結果の終了指示。
 *    保留するとセッションが `/session-end` を走らせないまま死ぬので通す。
 *  - **automatic** (`auto:goal-and-go` / `auto:inquiry` / `taskflow:*` / `revisor` /
 *    `delegation:*` など) — 人が居ないまま「進め」と言う指示。質問が開いている間に
 *    これを流すと、モデルが**自分の質問に自分で答えて**先へ進んでしまう。ここだけ保留する。
 *
 * source の書式は Concordia `src/shared/inject-source.ts` と対の関係。 platform と
 * user id が揃っているものだけを human と見なし、判定不能 (source 無し) は
 * **automatic** 扱いにする — 出どころが分からない inject を人間の発言として質問に通すより、
 * 保留して人間の回答を待つほうが安全側に倒れる。
 *
 * SRP: source 文字列の解釈のみ。保留するかどうかの判断は pending-question-gate。
 */

/** `discord:<uid>` / `slack:<uid>` 形式 (Concordia の requester source と同形)。 */
const HUMAN_SOURCE_RE = /^(discord|slack):([^:]+)/;

/** セッション終了指示 (Concordia `AUTO_SESSION_END_INJECT_SOURCE`)。 */
const LIFECYCLE_SOURCES = new Set(["auto:session-end"]);

export type InjectClass = "human" | "lifecycle" | "automatic";

/** inject の出どころ分類。source 不明は automatic (安全側)。 */
export function classifyInject(source: string | null | undefined): InjectClass {
  if (typeof source !== "string") return "automatic";
  if (LIFECYCLE_SOURCES.has(source)) return "lifecycle";
  const match = HUMAN_SOURCE_RE.exec(source);
  const userId = match?.[2]?.trim();
  return match && userId ? "human" : "automatic";
}

/**
 * 未回答の ask マーカー質問が開いていても pty へ通してよい inject か。
 * automatic だけが回答を待つ (= 保留される)。
 */
export function bypassesMarkerHold(source: string | null | undefined): boolean {
  return classifyInject(source) !== "automatic";
}
