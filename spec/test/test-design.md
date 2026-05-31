# テスト設計

ランナーは **`node:test` + `tsx`**（`npm test` = `node --test --import tsx tests/*.test.ts`）。
CI（`.github/workflows/ci.yml`）で build / typecheck / unit / smoke-sidecar を実行。
方針は AIFormat [`RULE_TEST.md`](https://github.com/LUDIARS/AIFormat/blob/main/RULE_TEST.md)。

> Lictor は **ローカルアプリ（CLI ラッパ）** 種別。重視点は 2 つの trust boundary
> （タイトルサニタイズ・キーストローク注入）と、Concordia 不在時の graceful 劣化。

## 種別と対象

### 1. ビルド / 型チェック（CI 必須）
- `npm run build`（tsc）/ `npm run typecheck`（--noEmit）。

### 2. ユニット（`node:test`、ネットワーク不要）
`tests/*.test.ts`（18+ 本）。重点:
- **サニタイズ（trust boundary）**: `osc.test.ts`（C0 除去・長さ cap・多バイト保持）、
  `rename.test.ts` / `slash-keys.test.ts`（先頭 `/` 除去・slash チェイン防止）。
- **provider 判定**: `provider.test.ts`（claude vs codex）。
- **skill 注入**: `skill-injector.test.ts`（name 正規表現・32 KiB cap・write/delete）、
  `memory-loader.test.ts`（repo 関連メモリのスコアリング）。
- **Concordia 連携**: `concordia.test.ts`（登録）、`event-reactor.test.ts`、
  `task-relay.test.ts`、`discord-channels.test.ts`、`ask-question-relay.test.ts`、
  `permission-proxy.test.ts`、`delegation-inject.test.ts`、`transcript-tail.test.ts`。
- **その他**: `active-repos.test.ts`、`auto-title.test.ts`、`version.test.ts`。

### 3. smoke（CI 必須・Concordia 不在）
- `tests/smoke-sidecar.mjs` — in-process sidecar。全 HTTP エンドポイントを叩き、
  **Concordia 不在時に 503 を返す経路**（chat/report/event/transcript 等）を確認。

### 4. round-trip（CI 対象外・手動）
- `tests/smoke-roundtrip.mjs` — `127.0.0.1:17330` の実 Concordia に対し
  `lictor-smoke-<uuid>` セッションを作成→削除する通し。
- `tests/local-server.mjs` — 長時間稼働 sidecar（ptyWriter→stdout logger）。
  別端末から sidecar を curl して HTTP 層を反復確認する用途。

## 充実度の見方（やること）
- 「何を充実とみなすか」= **2 trust boundary のサニタイズ網羅** と
  **Concordia 503 フォールバック**。ここが薄いと不充実。
- [ ] ConPTY ストレス下の pty 注入 / skill 注入の race は未カバー（将来）。
