# 委託 prompt 自動注入

## 目的
Concordia の delegation（`/v1/delegation/invoke`）で他エージェント（Codex 等）に
作業を委託する際、描画済みの **委託 prompt をラップ中 CLI に自動で貼付+送信** する。

## 振る舞い（[`../../src/delegation-inject.ts`](../../src/delegation-inject.ts)）
- Concordia が `CONCORDIA_DELEGATION_PROMPT_FILE` に描画済 prompt ファイルパスを
  セットして Lictor を起動する。
- Lictor は TUI が立ち上がった後（初回 pty 出力 + `LICTOR_DELEGATION_INJECT_DELAY_MS`
  既定 2500ms の遅延 = TUI 描画待ち）に、prompt を貼付し送信する。
- Codex CLI には slash command 機構が無いため、この自動注入が委託の入口になる。

## テスト
`tests/delegation-inject.test.ts`。関連: env は [`../setup/setup.md`](../setup/setup.md)。
