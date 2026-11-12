# chat の UTF-8 ファイル入力

関連タスク: `actio:8579e1fa-9bb1-421c-9d59-a95c68e324ef`

## 入力契約

`lictor cli chat <channel> --text-file <path>` はファイルをバイト列として読み、
UTF-8 を厳密に復号する。先頭の UTF-8 BOM は 1 個だけ除去する。
改行（CRLF を含む）、引用符、残りの空白は変換せず送信する。
空または空白のみのファイルは拒否する。
位置引数形式 `<channel> <text...>` の空白連結は従来どおり維持する。
`--text-file` は予約引数で、位置本文との併用や複数指定は認めない。

引数不足・余分・混在は `invalid_arguments`、読取失敗は `file_read_failed`、
不正 UTF-8 は `invalid_utf8`、空本文は `empty_text` として終了コード 2 で拒否する。
入力エラーは固定文言だけを出し、本文・パス・OS の例外を含めない。
拒否時は HTTP を発行しない。正常時は既存 `/v1/chat` への JSON POST を 1 回行う。
送信先解決・認可・mention・配送判定は既存の sidecar に委ね、自動再送しない。

## 契約と検証計画

C-2 decodeChatText(bytes): 不正UTF-8と空白のみの本文を固定エラーで拒否し、先頭BOMだけを除いた本文を保持する

Augur plan の既存動作固定提案に沿い、位置引数の互換性を固定してから、
日本語・複数行・引用符・BOM・不正バイト・読取失敗・不正引数を回帰ケースにする。
CLI 経由で送信 JSON と拒否時の未送信、エラーの秘匿性、失敗時の再送なしを確認する。
今回の指示によりテスト・サービス起動は実行しない。契約実行証跡は未取得として報告する。

## 再利用

既存 `cmdChat` の `postJsonText` と `/v1/chat` を再利用する。
他コマンドの単純な `readFileSync(..., "utf8")` は不正 UTF-8 を置換するため採用せず、
本文入力だけを独立した `chat-input.ts` に分ける。新しい依存は追加しない。

契約観測は Augur 配布のローカル runtime を利用する。引数・本文・パスはログへ出さず、
固定判定のみをローカル JSONL に記録する。runtime 自体のネットワーク通信はない。
package.json / lockfile は変更せず、インストールや導入時スクリプトは実行しない。
既存の esbuild 二世代（tsx / vite）と各導入スクリプトは今回の機能に必要ないため、
互換性に影響する依存整理をこの変更には含めない。

## 静的確認結果

契約 lint と `git diff --check` は通過。
worktree に node_modules がないため `npm run typecheck` は tsc 不在で実行できなかった。
既存 checkout の TypeScript / Node 型定義を読取り利用し、`src/chat-input.ts`・
`src/client.ts`・`tests/chat-input.test.ts` とその依存先を `--noEmit --strict` で確認した。
テスト、サービス起動、実配送は行っていない。
