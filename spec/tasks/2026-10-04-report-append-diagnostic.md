# 日報追記の既知404診断

参照: actio:42b00130-bc52-4619-9cb9-0d48c3dfd453

## 作業単位

- [x] 上流の応答形式と既存クライアント・sidecarの境界を確認する。
- [x] 実装前に契約と判定述語を定義する。
- [x] 日報追記専用の既知404分類とsidecar応答を実装する。
- [x] 正常・未知エラー・未登録・通信失敗・秘密情報非露出の回帰テストを追加する。
- [x] API仕様とREADMEを更新する。
- [ ] 静的確認後にCc経由でcommit・local PR提出する。

## 受け入れ契約

C-1 isMissingReportResponse(status, text): HTTP404かつJSONのerrorがreport_not_foundの場合だけ真を返す

## 検証計画

`augur plan --kind bug_fix --base main` の提案に従い、既知404を再現する回帰テストを作成し、隣接するエラー経路と他ルートの挙動を固定する。
実行は禁止されているため、単体・統合・起動テストは実行せず、静的確認とRevisorの検証に委ねる。
Augur契約の実行観測が無い場合は未充足と報告する。

## 実装内容・再利用判断

既存の`fetchJson`によるHTTP送信とsidecarの入力検証・identity付与・共通catchを再利用した。
日報追記だけが診断オプションを指定し、構造化JSONとHTTP状態で既知エラーを分類する。
文字列例外解析は採用せず、固定messageだけを持つ専用エラーを使う。
他エラーの秘匿仕様を今回の変更で拡張せず、既存応答を回帰テストで固定した。

## 検証結果と制約

- `augur contracts lint --project . --json`: findingsなし。
- `augur inject apply --project . --rule contract-wrap --diff-base main`: Anatomiaのworktree外ログ書込がEPERMで失敗。注入なし。
- 契約ランタイム`@ludiars/log-weaver`は本リポジトリの依存に無く、注入再開時には導入判断も必要。
- テストは12ケース追加したが、依頼の禁止に従い未実行。サービス起動・再起動なし。
- 契約集計に使用する`DELEGATION_STARTED_AT`は環境に未設定。runの開始時刻を照会して集計する。
- runの`created_at`（2026-10-04T00:07:19.328Z）から集計: C-1は`uncovered (not-injected): calls 0, observed 0, violations 0`、`met: false`。
- `git diff --check`: 問題なし。変更したTypeScript 5ファイルの構文診断は0件。新規診断モジュールと契約述語の`tsc --noEmit --strict`は成功。
- worktreeには依存パッケージが未展開のため、全体typecheckは未実施。上記静的確認には共有checkoutの既存TypeScriptを読み取り利用した。

## 障害記録

依頼で報告された症状は、日報追記の上流report_not_foundも共通catchにより500となり、日報不在とその他障害を機械判別できないこと。
上流`reports.ts`は`{error:"report_not_found"}`と404を返すが、クライアント`fetchJson`は汎用Errorを投げることをコードで確認した。稼働環境での再現は未実施。
共有mainへの書き込みは禁止されているため、この作業記録に調査事実を残す。
