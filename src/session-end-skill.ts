/**
 * `session-end` skill content.
 *
 * Provider 横断で「セッション終了の一連処理」 を AI 自身が回すための skill.
 * Claude Code は別途 `.claude/commands/session-end.md` を slash command として
 * 持つが、 Codex CLI には slash command 機構が無いため、 同等のフローを skill
 * として配布する. Codex セッションでユーザが「session-end してください」 等
 * 自然言語で促した時、 この skill が discover されて実行される.
 *
 * 2 つの重要ポイント:
 *
 *  - **冒頭で ack を出す**: 終了処理は時間がかかる (残作業整理 / log 保存 /
 *    memory 更新) ので、 何も応答せずに作業に入ると wrapper 側からは
 *    「アプリケーションが応答しませんでした」 と見える. 最初に短く受付応答を
 *    出してから本作業へ.
 *  - **ポエム (独白) は自分のロールで書く**: Claude セッションで Claude が
 *    書くのと同じく、 Codex セッションでも Codex 自身が書く. 上位 AI に
 *    丸投げしない.
 */
export const SESSION_END_SKILL_NAME = "session-end";

export const SESSION_END_SKILL_DESCRIPTION =
  "セッション終了の一連処理 — 受付応答 → 残作業報告 → セッションログ保存 → memory 更新 → 独白. Codex CLI には slash command 機構が無いため、 ユーザが「session-end して」 等と頼んだら自発的にこの skill を回す.";

export const SESSION_END_SKILL_BODY = `# session-end

このセッションを締めくくる. 以下を **順番に** 実行する.

## 1. 受付応答を最初に返す (必須)

実装作業に入る前に、 ユーザに対して短く 1 文の受付応答を出す. 例:

> session-end を受け付けました。 残作業整理 → ログ保存 → 独白 の順で進めます。

これが無いと、 wrapper 側で「アプリケーションが応答しませんでした」 と
判定されてしまう. 最初のメッセージとして必ず出す.

## 2. 残作業を整理して報告

このセッションで触ったリポジトリについて、 以下を 1-2 行ずつ:

- 未 commit 差分の有無
- ローカル branch と origin との ahead/behind
- 開いた / 残した PR、 関連 Issue
- 引き継ぎたい TODO

長い羅列は不要、 「次のセッションが見て分かる粒度」 を目指す.

## 3. セッションログを保存

\`E:/Document/Ars/session-logs/YYYY-MM-DD.md\` (日付は当日) に追記する.
ファイルが無ければ新規作成. 形式は既存ログに合わせる (おおよそ
「## HH:MM — \\<タイトル\\> / \\<persona\\>」 のヘッダ + 段落本文).

## 4. memory 更新 (必要なときだけ)

以下のいずれかに該当するなら \`memory/\` を更新する. 該当しなければ skip:

- 「次セッションで再現したい知見 / 苦労した経験」 が今回出てきた
- 既存の feedback / project 系 memory が outdated と分かった
- 新しい project / reference 系の対象が出現した

\`MEMORY.md\` index と個別ファイル両方を編集.

## 5. 自分のロールで独白 (ポエム) を書く

最後に、 1 段落の独白を書く. これは provider が誰であっても **自分で** 書く
(「Claude に書いてもらう」 「上位 AI に丸投げ」 はしない). Codex セッション
なら Codex が書く. Claude セッションなら Claude が書く.

トーン: 今回 assign された persona / role に沿う. 内容は当日のハイライト /
引っかかったこと / 明日への一言 等. 長くしない (3-5 文程度).

## やらないこと

- session-logs のリポ commit / push は **行わない** (ローカル運用、 必要なら
  ユーザ指示でコミット).
- 関連リポの commit / push もこの skill では行わない.

## 起動

ユーザが \`/session-end\` (Claude) や 「session-end してください」 「セッション
終了処理して」 等 (Codex) と言ったら、 この skill を実行する.
`;
