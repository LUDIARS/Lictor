---
task: codex-session-rebind-runtime-rollout
project: Lictor
kind: テスト
created: 2026-09-08
memory_links:
  - spec/plan/problem_logs/2026-09-08-codex-in-pty-session-replacement.md
  - spec/setup/setup.md
---
# Codex 会話切替追従の本体反映と実動作確認

## 目的

同じ Lictor PTY 内で Codex の会話 ID が変わった際に、旧 JSONL への固定によって
Discord リレーが止まる問題の修正を実際の起動元へ反映し、リレーの継続を確認する。
修正のコミットは `70f380ba069b` (親は `300d2f0`) で、2026-09-08 時点では main 未到達。
同確認では npm の Lictor リンク先は `E:/Document/Ars/Lictor` で、本体 main は `300d2f0`、
新しい追従モジュールの dist は未配置だった。

## 完了条件

- Revisor が管理する反映経路で `70f380ba069b` が main 経由で起動元 checkout に到達し、
  ビルド成果物がソースと一致することを確認する。既存の未コミット変更を上書きしない。
- 本体フォルダを使う許可済み確認セッションで、旧 JSONL を残したまま同一 wrapper 内に
  新しい top-level Codex 会話を作り、watchdog または repin が追従することを確認する。
- provider session ID と Concordia の authoritative transcript_path が更新され、
  新会話の応答が同じ配送先へ届くこと、旧応答が再送されないことを確認する。
- 新旧 claim の受け渡しと終了時の解放を確認し、他 wrapper・子エージェント・曖昧な候補に
  切り替わらないことを確認する。明示的 App Server thread pin は維持する。
- 実行結果を TestWorkflow と問題記録に残す。既存の稼働 wrapper はコードをメモリに保持するため、
  ビルドだけで更新されたと扱わない。旧障害セッションは既に ended のため再起動対象にしない。

## スコープ (編集可ディレクトリ)

- 本体 `dist/` のビルド成果物と Revisor が管理する配置・反映経路。
- `spec/plan/problem_logs/2026-09-08-codex-in-pty-session-replacement.md` の検証記録。
- 新しい実装変更が必要なら別タスクに切り分ける。

## 実行条件

- 動作確認は人間の確認開始指示に従う。起動・再起動は Excubitor 経由かつ本体フォルダのみ。
- 開始前に Concordia testing claim、終了時に release を行う。worktree から起動しない。
- ポートと endpoint は Excubitor catalog / ProcessMap から解決する。
- 進行状態と担当は Concordia DB に保持し、このタスク本文へ書き戻さない。
