---
task: cc-spawn-disallow-askuserquestion
project: Lictor
kind: 実装
created: 2026-09-05
memory_links: []
---

# Cc spawn の Claude セッションで AskUserQuestion を無効化し、呼ばれた場合は ask マーカーへ変換する

## 目的

Concordia 問題ログ 2026-09-05 (委託先 Claude セッションが AskUserQuestion を使った) の修正要件 1・2。
ask マーカーの system prompt 追記は届いていても、Claude Code 既定の「ブロックされたら AskUserQuestion」に
負けてリレー越しに答えられない picker で委託が止まる。ツールを物理的に使えなくし、それでも transcript に
出たら質問カードへ変換する保険を置く。

## 完了条件

- Claude provider で Cc spawn (enrollment = concordia_spawn_id env あり) のとき claude 起動引数に
  `--disallowedTools AskUserQuestion` を付ける。人間が直接起動した対話セッションでは付けない
- `ask-marker-system-prompt.txt` の文言を「使わないでください」から「AskUserQuestion は使えません。
  ask マーカーだけが回答経路です」に強める
- transcript 監視 (detectAskMarker と同じ経路) で `tool_use` name=AskUserQuestion を検出したら、
  その questions[].question / options[] / multiSelect を AskMarker 相当に変換してリレーへ流し、stderr に
  `[ask-marker] converted AskUserQuestion` を記録する
- 変換した質問は組み込み picker の経路 (`onQuestionOpen` / `pickerQuestionIds` / キー注入) に載せず、
  ask マーカーと同じテキスト回答経路へ載せる。存在しない picker を待つ pending gate を開かない
- 単体テスト: 引数付与の条件分岐 (enrollment 有/無)、AskUserQuestion tool_use 行 → AskMarker 変換
  (multiSelect を含む)、変換時に picker の pending gate を開かないこと、既存の ask-marker 検出テストが緑のまま
- spec (SPEC-ASK-MARKER-ACTIVATION 周辺) に無効化と変換の 2 段を追記

## スコープ (編集可ディレクトリ)

- src (provider / wrap / ask-marker 関連)
- spec
- tests
