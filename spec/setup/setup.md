# セットアップ

## 前提
- **Node.js ≥ 22**（global `WebSocket` を使用）。
- ネイティブ依存は prebuilt のみ: `node-pty@^1.1`（ConPTY / macOS / Linux の
  prebuild を同梱、コンパイラ不要）。**gyp-from-source 依存は禁止**（追加する
  ネイティブ依存も prebuild 同梱必須）。
- TypeScript strict。テストランナーは `node:test` + `tsx`（vitest/jest は使わない）。

## インストール / ビルド / 起動
```sh
git submodule update --init   # lib/vestigium（vendored 依存）
npm run setup                 # lib/vestigium をビルド（npm は file: 依存をビルドしない）
npm install
npm run build       # tsc -p tsconfig.json → dist/
npm run typecheck   # tsc --noEmit
npx lictor claude   # claude をラップして起動（provider 自動判定）
npx lictor codex    # codex CLI をラップ
```
エントリは `bin/lictor.mjs`（`dist/cli.js` を読む）。

### SETUP-VENDORED-BUILD: vendored 依存の自動ビルド
`@ludiars/vestigium` は `file:./lib/vestigium`（git submodule）依存で、npm は
node_modules に symlink を張るだけでビルドしない。submodule を checkout した
だけの状態は `dist/` が無く、`main` が指す `dist/index.js` を解決できないため
`lictor cli` が起動時に全滅する（症状は「Discord に返事が返らない」という遠い
場所にしか出ない）。

**npm のライフサイクルフックでは救えない。** npm は file: 依存の reify（依存側
`prepare` の実行を含む）を **ルートの `preinstall` / `postinstall` より先に**
完了させる。2026-08-01 の実測では、ルートに `preinstall` を置いても一度も実行
されないまま依存側 `prepare` の失敗で install が中断した。したがって親側の
フックは「install の前に vendored 依存をビルドする」用途には使えない。
**`package.json` に `postinstall` を置かないのは意図的**で、代わりに手動の
`npm run setup` と下記の入口自己修復で担保する。

対策は 2 段構えになっている。

1. **依存側の根治** — `lib/vestigium` の `prepare` が local tsc 不在時に自分で
   devDependencies を入れてからビルドする（Vestigium 側で修正）。これにより
   `npm install` が素の状態から通る。
2. **入口での自己修復** — `bin/lictor.mjs` が `@ludiars/*` の
   `ERR_MODULE_NOT_FOUND` を検出したら `scripts/build-vendored-deps.mjs` で
   ビルドし、1 回だけ再試行する。hook（`lictor cli ...`）も wrapper 起動も
   必ずこの入口を通るので、submodule pin が古い環境でも全経路が救われる。

`scripts/build-vendored-deps.mjs`（`npm run setup` / 上記の自己修復から呼ばれる）
は以下を行う:

| 条件 | 挙動 |
|---|---|
| `lib/<pkg>/package.json` が無い | warning のみ出して継続（submodule 取得前の clone を壊さない） |
| `dist/index.js` が全 `src` ファイルより新しい | skip（ビルド済み） |
| それ以外 | 当該ディレクトリで `npm install --include=dev` → `npm run build` |

- 対象は `VENDORED_PACKAGES`。vendored 依存が増えたらここに足す。
- 自己修復経路は `buildVendoredPackage(dir, { force: true })` で呼ぶ。解決に
  失敗している時点で `dist` は当てにならず、mtime 比較で skip すると「ビルド
  したと言いながら何もせず同じエラーで落ちる」最悪の分岐になるため。
- 自己修復後の再 import はクエリ付き URL（`?vendored-repair=1`）で行う。ESM
  ローダは link に失敗した URL を記憶しうるので、素の再 import ではビルドが
  成功しても同じ `ERR_MODULE_NOT_FOUND` が返る恐れがある。
- 子 npm は `NODE_ENV=development` + `--include=dev` で回す（親が production
  だと `typescript` が落ちて `tsc` が見つからない）。
- Windows では `npm.cmd` を `shell: true` で起動する（Node 20.12+ は
  shell 無しでの `.cmd` 起動を EINVAL で弾く）。渡す引数はすべてスクリプト内の
  リテラルで、外部入力は shell に渡らない。

## 環境変数（Lictor が読む）

| 変数 | 既定 | 効果 |
|---|---|---|
| `CONCORDIA_HOST` | `127.0.0.1` | Concordia の listen 先 |
| `CONCORDIA_PORT` | `11111` | Concordia backend port (本体 concordia.config.json に合わせる。 通常は spawn 時注入) |
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
