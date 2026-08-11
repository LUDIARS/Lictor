---
task: permission-defer
project: Lictor
kind: 実装
status: done
created: 2026-08-08
source_session: lictor-d56d4998-191c-49a3-a8b0-bc0a25f4b676
memoria_task_id: null
actio_task_id: null
memory_links: []
---

# self-processable な PreToolUse 許可通知の遅延判定

## 目的

legacy auto-like mode（`acceptEdits` / `bypassPermissions` / `dontAsk`）で自動承認される
無害なツール呼び出しの許可通知が Concordia へ全件流れ、
Discord がノイズで埋まる。 自分で処理できる要求は投稿を抑制し、 本当に人間が
必要な (= Claude が TUI で聞いていてセッションが止まった) ときだけ通知する。

## 完了条件

- [x] Claude Code の `permission_mode` と guard 結果を permission hook から中継する。
- [x] 既知の auto 承認モード かつ 無害な read-only ツールだけを self-processable と分類する。
- [x] **self-processable は即座に `{"deferred": true}` を返し (decision を出さない)、
      Claude 自身の permission エンジンに委ねる。 追加レイテンシをゼロにする。**
- [x] **応答後に非同期で defer window (既定 5s) 後の transcript を観測し、
      進捗が無いときだけ Concordia へ投稿する。**
- [x] **観測タイマーは sidecar `close()` で全て cancel する (leak / 停止後投稿を作らない)。**
- [x] user-confirmation は即時投稿し、最大 10 分待って期限切れは `ask` を返す。
- [x] 投稿しなかった場合もローカル構造化ログ (`event: "permission-check"`) を残す。
- [x] 分類・進捗抑制・停滞投稿・即時人間確認を node:test で覆う。

## スコープ (編集可ディレクトリ)

- `src/permission-classify.ts` / `src/permission-defer.ts` / `src/permission-log.ts`
- `src/permission-hook.ts` / `src/sidecar.ts`
- `tests/permission-*.test.ts`
- `spec/feature/permission-proxy.md` / `spec/test/test-design.md`

## 修正 — 遅延判定はブロッキングであってはならない (W3a)

初回実装は `POST /v1/internal/permission-check` の中で defer window を `sleep` してから
transcript 進捗を比較していた。 これは本番で成立しない。 **PreToolUse hook は sidecar の
応答を待つ間ツール実行をブロックしている**ので、 その間セッションは JSONL に 1 行も
追記できない。 結果は (1) 進捗が検出されず全件投稿される = ノイズ削減が効かない、
(2) 自動承認されるはずの全ツール呼び出しに 5 秒の遅延が乗る。 旧テストは注入した
`sleep` の中で transcript を伸ばすモックだったため、 本番で起きない状況を自作して
green になっていた。

- [x] self-processable の応答を defer window より前に返す (順序の反転)。
- [x] 観測を `src/permission-defer.ts` の `PermissionDeferObserver` へ切り出し、
      停滞時のみ Concordia へ投稿する。
- [x] `dispose()` を sidecar `close()` に繋ぎ、armed な観測を全て cancel する。
- [x] 構造化監査ログを `src/permission-log.ts` へ分離 (SRP)。
- [x] テストを注入スケジューラ + 論理時計で書き直し、 実時間を待たずに順序を検証する。

## 検証

- `npm run typecheck` クリーン。
- `npm test` 442 pass / 0 fail。
- Revisor local PR #339 — Open / Test OK。
  autofix (`e2ab9ed`) が write-only だった `permission_mode` フィールドを監査ログから
  除去した。 `kind` / `tool_name` が残るため監査要件は維持される。

## 引き継ぎ

- マージ後に `npm run build` が必要 → `2026-08-08-lictor-dist-rebuild.md`。
