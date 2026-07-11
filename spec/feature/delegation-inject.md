# 委託 prompt 自動注入

## 目的
Concordia の delegation（`/v1/delegation/invoke`）で他エージェント（Codex 等）に
作業を委託する際、描画済みの **委託 prompt をラップ中 CLI に自動で貼付+送信** する。

## Target: Codex App Server 経路

Codex delegation の target implementation は、App Server の stdio JSON-RPC 経路である。

- App Server の `thread/start` 応答で thread/session ID を確定する。
- binding frame の Concordia 永続化を確認してから `turn/start` に委託 prompt を渡す。
- App Server の item/turn event を直接 transcript frame 化する。
- PTY、遅延貼付、CR送信、submit watchdog、rollout discovery は使用しない。
- App Server 失敗時に legacy 経路へ自動 fallback しない。

完全な状態遷移、失敗条件、受入テストは
[`codex-first-turn-transcript-sequence.md`](codex-first-turn-transcript-sequence.md) を参照。

## Legacy 振る舞い（[`../../src/delegation-inject.ts`](../../src/delegation-inject.ts)）
- Concordia が `CONCORDIA_DELEGATION_PROMPT_FILE` に描画済 prompt ファイルパスを
  セットして Lictor を起動する。
- Lictor は TUI が立ち上がった後（初回 pty 出力 + `LICTOR_DELEGATION_INJECT_DELAY_MS`
  既定 2500ms の遅延 = TUI 描画待ち）に、prompt を貼付し送信する。
- この経路は `LICTOR_CODEX_TRANSPORT=legacy` の互換退避用とし、通常経路にはしない。

## テスト
`tests/delegation-inject.test.ts`。関連: env は [`../setup/setup.md`](../setup/setup.md)。

旧経路の二段書きは安全な所有権束縛を提供しない。新規実装では App Server 経路を使用する。
