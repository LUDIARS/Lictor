# PR 提出結果の照合 (LI-PR-SUBMIT-01)

Actio 参照 `actio:8a6e1a61-c0bb-408c-ab1d-074f8443a7d6`

`lictor cli pr submit` は、送信後の接続断、応答途中の切断、タイムアウトなどで
受付結果を取得できなかったとき、結果不明と stderr に表示して終了コード 1 を返す。
Concordia が Revisor への提出・再審査 POST の通信異常を返した場合も同じ扱いとする。
Revisor の明示的な拒否や一覧取得などの事前確認の失敗は、従来の出力と終了コードで返す。
Concordia が既存の照合で受付を確認できた場合は通常の成功応答を返す。

案内には対象の checkout パスとブランチを含める。`--branch` がなければ送信時の
checkout から取得し、判明しなければその旨を示す。
再送前の照合には Concordia の読み取り専用 `GET /v1/prs/revisor` を使い、
対象 checkout の origin に対応する `repository` と `headRef` を確認する。
一覧で一致が見つからない場合も、処理中の可能性がある。

sidecar から Concordia までの期限は 90 秒、CLI から sidecar までの期限は 120 秒とし、
いずれも応答本文の読了までを対象にする。Lictor は照合・自動再送・設定変更を行わない。
提出先とセッションの付与方法は従来どおりとする。

回帰ケースは `tests/pr-submit-cli.test.ts`、`tests/pr-submit-outcome.test.ts`、
`tests/implementation-tools.test.ts` で扱う。
