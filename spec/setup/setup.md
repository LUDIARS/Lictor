# セットアップ

## 前提
- **Node.js ≥ 22**（global `WebSocket` を使用）。
- ネイティブ依存は prebuilt のみ: `node-pty@^1.1`（ConPTY / macOS / Linux の
  prebuild を同梱、コンパイラ不要）。**gyp-from-source 依存は禁止**（追加する
  ネイティブ依存も prebuild 同梱必須）。
- TypeScript strict。テストランナーは `node:test` + `tsx`（vitest/jest は使わない）。

## インストール / ビルド / 起動
```sh
npm install
npm run build       # tsc -p tsconfig.json → dist/
npm run typecheck   # tsc --noEmit
npx lictor claude   # claude をラップして起動（provider 自動判定）
npx lictor codex    # codex CLI をラップ
```
エントリは `bin/lictor.mjs`（`dist/cli.js` を読む）。

## 環境変数（Lictor が読む）

| 変数 | 既定 | 効果 |
|---|---|---|
| `CONCORDIA_HOST` | `127.0.0.1` | Concordia の listen 先 |
| `CONCORDIA_PORT` | `17330` | 同上 |
| `LICTOR_DISABLE_CONCORDIA` | (unset) | `1` で Concordia 連携を完全に skip |
| `CONCORDIA_DELEGATION_PROMPT_FILE` | (unset) | Concordia `/v1/delegation/invoke` が描画した prompt ファイル。TUI 起動後に貼付+送信 |
| `LICTOR_DELEGATION_INJECT_DELAY_MS` | `2500` | 初回 pty 出力後、委託 prompt 注入までの遅延（TUI 描画待ち） |
| `CLAUDE_CODE_GIT_BASH_PATH` | — | Windows で Node から claude を spawn する際に必須 |

## 環境変数（子プロセスへ注入）

| 変数 | 内容 |
|---|---|
| `LICTOR_PORT` | この session の sidecar loopback port |
| `LICTOR_PID` | lictor ラッパの PID |
| `LICTOR_SESSION_START` | ラッパ起動の ISO timestamp |
| `LICTOR_SESSION_ID` / `CONCORDIA_SESSION_ID` | Concordia session id（登録成功時。後者は互換用） |
| `LICTOR_PERSONA_NAME` | persona の role kind（例 `深掘り型`） |
| `LICTOR_ROLE_LABEL` | server 供給の `role_label` |

## プラットフォーム注意（Windows）
- Tauri 等と異なり Lictor は端末ラッパ。Windows では ConPTY を使用。
- `CLAUDE_CODE_GIT_BASH_PATH` 未設定だと spawn が exit 1 になる場合がある。
