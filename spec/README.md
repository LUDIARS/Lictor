# Lictor 仕様書

Claude Code / Codex CLI をラップする per-session sidecar **Lictor** の仕様。
AIFormat [`FORMAT_SPEC.md`](https://github.com/LUDIARS/AIFormat/blob/main/FORMAT_SPEC.md)
の 6 分類に整理する。詳細な背景・設計判断は [`../DESIGN.md`](../DESIGN.md)、
利用方法は [`../README.md`](../README.md) を参照。

## 構成

```
spec/
├── feature/     # 機能概要（サブシステム別 1 ファイル）
├── interface/   # sidecar HTTP API + Concordia クライアント契約
├── setup/       # セットアップ・環境変数・起動
└── test/        # テスト設計
```

> `data/` は **N/A** — Lictor はステートレスな per-session ラッパで、永続データを
> 持たない（状態は Concordia / env / pty 側）。`plan/` はロードマップを
> [`../DESIGN.md`](../DESIGN.md) §Roadmap に置くため未設置。

## feature 一覧

| ドキュメント | 概要 |
|---|---|
| [pty-wrapping.md](feature/pty-wrapping.md) | node-pty で CLI を子プロセスとしてラップ・I/O 中継 |
| [terminal-title.md](feature/terminal-title.md) | OSC 0 端末タイトル制御 + 自動タイトル |
| [keystroke-injection.md](feature/keystroke-injection.md) | TUI への slash / keys / rename / answer 注入 |
| [concordia-integration.md](feature/concordia-integration.md) | セッション登録 / WS 生存 / stat ポーリング / chat・report・event 中継 |
| [skill-injection.md](feature/skill-injection.md) | per-session SKILL.md 注入 + repo 関連メモリ供給 |
| [transcript-relay.md](feature/transcript-relay.md) | ラップ中 CLI の transcript 読み取り・転送 |
| [permission-proxy.md](feature/permission-proxy.md) | PreToolUse 許可判断の Concordia 中継 |
| [delegation-inject.md](feature/delegation-inject.md) | 委託 prompt の自動貼付・送信 |
| [codex-first-turn-transcript-sequence.md](feature/codex-first-turn-transcript-sequence.md) | App ServerでのCodex ID確定、delegation/interactive分岐、初回`transcript_logs`永続化 |
| [task-protocol.md](feature/task-protocol.md) | 現在タスク/ブランチの宣言と skill 反映 |
