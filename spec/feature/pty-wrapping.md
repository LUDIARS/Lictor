# pty ラッピング

## 目的
Claude Code / Codex CLI を **pty 子プロセス** として起動し、ユーザ端末との
I/O を透過中継しつつ、sidecar から介入できる土台を作る。これが Lictor の
中核（「drop-in wrapper」不変条件）。

## 振る舞い
- `lictor <provider> [...args]` で provider（claude / codex）を判定し
  ([`../../src/provider.ts`](../../src/provider.ts))、`node-pty` で spawn
  ([`../../src/wrap.ts`](../../src/wrap.ts))。
- `lictor grok [args...]` は Grok CLI を起動し、Concordia に `grok-cli` として登録する。
  解決順は `LICTOR_GROK_BIN`、`PATH`、既定位置（Windows は
  `%USERPROFILE%/.grok/bin/grok.exe`、POSIX は `~/.grok/bin/grok`）。入力注入は
  本文と Enter を別々に送信する。スキルの探索は Grok が担当する。会話ログの中継と
  セッション ID の固定は対象外とする。関連 Actio タスク `actio:07b0c6af-dd5c-4307-9ff4-e382c691fa6b`。
- 子の stdout/stderr を端末へ、端末の stdin を子へそのまま流す。
- 端末リサイズ（SIGWINCH 相当）を pty に伝播、シグナルを中継。
- 子の出力は `ptyWriter` 経由でのみ書き込む（注入系もここを通す）。
- 子の exit を検知してラッパも終了し、Concordia セッションを `DELETE`。

## 設計判断（[`../../DESIGN.md`](../../DESIGN.md) §Why pty.spawn）
- named pipe / signal / stdin 注入ではなく **HTTP loopback + pty** を採用。
  TUI への安全な書き込みと外部からの制御を両立するため。
- ネイティブ依存は prebuild 同梱のみ（`node-pty`）。コンパイラ不要を維持。

## 関連
- 子へ注入される env: [`../setup/setup.md`](../setup/setup.md)。
- 端末タイトル: [`terminal-title.md`](terminal-title.md)。キーストローク注入:
  [`keystroke-injection.md`](keystroke-injection.md)。
