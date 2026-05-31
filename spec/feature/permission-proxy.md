# 許可プロキシ（PreToolUse）

## 目的
Claude Code の **PreToolUse 許可判断** を Concordia / Web UI 側へ橋渡しし、
セッション横断での許可制御（auto-mode の許可範囲抑制等）を可能にする。

## 振る舞い（[`../../src/permission-hook.ts`](../../src/permission-hook.ts)）
- PreToolUse hook のブリッジとして動作し、session-scoped な settings 注入で
  許可/保留を返す。
- Concordia Web UI 側で「保留 → 後から判断」する deferred decision に対応。
- auto-mode の抑制対象は「自動実行可能範囲のツール許可」であり、AskUserQuestion の
  ような危険操作確認は対象外（auto-mode でも user 確認）。

## テスト
`tests/permission-proxy.test.ts`（PreToolUse 許可中継の経路）。
