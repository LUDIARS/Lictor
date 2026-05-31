# 端末タイトル制御

## 目的
並行セッションをタスクバー / Alt+Tab で識別できるよう、端末タイトルを
`[<コード>] <作業内容>` 等に保つ。手動指定と自動生成の両方をサポート。

## 振る舞い
- **手動**: `POST /v1/title {text}` で OSC 0 を発行し、**手動オーバーライド**を
  立てる。以降の自動更新を抑止。[`../../src/osc.ts`](../../src/osc.ts) が
  サニタイズ（C0/DEL 除去・200 文字 cap・多バイト保持）して `writeOsc`。
- **自動解除**: `POST /v1/title/auto` でオーバーライドを外し、次の stat 周期から
  自動タイトルが再開。
- **自動**: [`../../src/auto-title.ts`](../../src/auto-title.ts) が stat 周期
  （[`../../src/stat.ts`](../../src/stat.ts)）で cwd / branch 等からタイトルを
  生成。競合検知時は `⚠N` prefix を付ける。

## Trust boundary
- タイトル書き込みは必ず `setTitle` / `writeOsc` を経由（`process.stdout.write` に
  生 payload を直書きしない）。これは security 不変条件。

## 関連エンドポイント
`POST /v1/title`, `POST /v1/title/auto`（[`../interface/sidecar-http-api.md`](../interface/sidecar-http-api.md)）。
