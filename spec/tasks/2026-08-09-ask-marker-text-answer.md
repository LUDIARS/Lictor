---
task: ask-marker-text-answer
project: Lictor
kind: 実装
created: 2026-08-09
memory_links: []
---
# テキスト返信を質問の回答として記録する

## 目的

ask マーカー質問が「メッセージを 1 通投げただけで回答済みになる」「WebUI で答えても反映されない」
と報告された (2026-08-09 neco)。原因は user フレーム検知で `resolve` を呼び、回答本文を捨てて
いたこと。本文を回答として残し、後続の WebUI / ボタン回答が 409 で潰れないようにする。

## 完了条件

- テキスト返信の本文が `answer-question` に記録される (選択肢コードがあれば index、無ければ自由文)。
- Concordia 不通 / 409 のときだけ resolve へフォールバックする。
- 選択肢コード `[A]` の解釈が単体テストで固定されている。
- 仕様が `spec/feature/ask-marker-text-answer.md` にある。

## スコープ (編集可ディレクトリ)

- `src/answer-code.ts`, `src/ask-question-relay.ts`, `src/transcript-tail.ts`, `src/wrap.ts`
- `spec/feature/`, `tests/`

## 残作業 (このタスク外)

- Concordia 側で質問カードに `[A]` コードを表示する (Discord embed / WebUI)。別 PR。
