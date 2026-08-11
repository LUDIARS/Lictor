# 許可プロキシ（PreToolUse）

> Spec ID: `SPEC-PERMISSION-PROXY`

## 目的
Claude Code の **PreToolUse 許可判断** を Concordia / Web UI 側へ橋渡しし、
セッション横断での許可制御（auto-mode の許可範囲抑制等）を可能にする。

## 振る舞い（[`../../src/permission-hook.ts`](../../src/permission-hook.ts)）
- PreToolUse hook のブリッジとして動作し、session-scoped な settings 注入で
  許可/保留を返す。
- Concordia Web UI 側で「保留 → 後から判断」する deferred decision に対応。
- Legacy auto-like modes are classified only for deferring notifications about
  harmless tools; dangerous tools stay on the human-confirmation path.
- Claude Code の現在の `permission_mode: "auto"` は Claude 自身の許可ポリシーを
  優先する。Lictor はこの値（前後空白・大文字小文字を無視）では**決定 JSON を出力せず**、
  sidecar / Concordia への問い合わせもしない。他の mode は従来どおり coordinator
  backed の許可フローに渡す。

## 遅延通知（self-processable）

**PreToolUse hook はツール実行をブロックしている**。 hook が sidecar の応答を
待っている間、 セッションは 1 行も進めない。 したがって sidecar 側で待ってから
判断する設計は成立しない (transcript は原理的に伸びず、 全リクエストに待ち時間が
乗るだけ)。 実際の順序は逆にする:

1. [`../../src/permission-classify.ts`](../../src/permission-classify.ts) が
   legacy auto-like mode（`acceptEdits` / `bypassPermissions` / `dontAsk`）かつ
   無害ツールを `self-processable` と分類する。現在の `auto` は hook 自体を bypass する。
2. sidecar は **即座に** `{"deferred": true}` を返す (decision を出さない)。
   hook は stdout に何も書かず、 Claude 自身の permission エンジンが処理する。
   追加レイテンシはゼロ。
3. 応答後、 [`../../src/permission-defer.ts`](../../src/permission-defer.ts) の
   `PermissionDeferObserver` が `PERMISSION_DEFER_MS` (既定 5000ms) 後に
   transcript を再観測する。
   - 進んだ → legacy auto-like mode が処理した。 Concordia へは投稿しない。
   - 進んでいない → TUI で人間に聞いていてセッションが止まっている。
     Concordia へ投稿し、 Discord / Web UI から気づけるようにする。
4. 観測タイマーは sidecar `close()` で全て cancel される
   (停止後に投稿しない / タイマーを leak させない)。
5. 投稿しなかった場合も
   [`../../src/permission-log.ts`](../../src/permission-log.ts) が
   stderr へ構造化ログ (`event: "permission-check"`) を残す。

`user-confirmation` に分類された要求は従来どおり即時投稿し、
`/v1/internal/permission-response` の応答を最大 10 分待つ (期限切れは `ask`)。

## テスト
- `tests/permission-proxy.test.ts` — PreToolUse 許可中継の HTTP 経路。
  注入したスケジューラと論理時計で「応答が defer window より先に返る」順序を検証。
- `tests/permission-defer.test.ts` — 観測器の進捗判定・dispose・late callback。
- `tests/permission-classify.test.ts` — 分類ルール。
- `tests/permission-mode.test.ts` — Claude native `auto` の proxy 回避。
