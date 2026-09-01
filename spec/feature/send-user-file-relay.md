# SendUserFile の Discord 中継

Claude Code の `SendUserFile` はローカル harness にファイルを渡すだけで、Lictor 経由の
リモート (Discord) にいる利用者には何も届かない。ツール自体は成功を返すため、
「送ったつもりで届いていない」が無言で成立する。Lictor はこれを PostToolUse hook で
捕捉し、Concordia chat の添付として同じファイルをセッションチャンネルへ出す。

## 経路

1. `PostToolUse` (matcher `SendUserFile`) が `lictor cli send-file-hook` を起動する。
   ツール実行後に発火するので、配送に失敗したファイルを中継してしまうことがない。
2. hook は stdin の payload から `tool_input.files` / `tool_input.caption` だけを取り出し、
   sidecar の `POST /v1/internal/send-file` へ渡す。判断は行わない。
3. sidecar が Concordia `POST /v1/chat` を呼ぶ。`attachment_paths` に実パスを載せ、
   `session_id` と送信先 Discord channel ID は sidecar が authoritative に刻印する。

## channel を "system" にする理由

Concordia egress は `chitchat` / `consultation` / `報告` を meta チャンネルへ強制送出する
(`discord/egress.ts` の `forceMeta`)。成果物はセッション自身のチャンネルに出したいので、
強制対象外の `system` を使う。`discord_channel_id` はセッションチャンネルと一致する時だけ
採用されるため、他セッションへの誤送出は起こらない。

## 失敗時

Concordia の添付ガードは workspace root / temp / `CONCORDIA_ATTACHMENT_ROOTS` の外を
拒否する。拒否された場合でも sidecar は添付なしのテキストで公開用の理由とファイル名を
投稿する。絶対パスや Concordia の応答本文はユーザー名、ローカル構成、private endpoint を
含みうるため投稿しない。無言で消すと、この機能が塞ごうとしている「届かないことに
気づけない」状態へ戻るため。

hook 自体は常に exit 0 で、出力も持たない。中継の失敗がセッションを止めることはない。

- SPEC-SENDFILE-RELAY-001 — `SendUserFile` 以外、または絶対パスの `files` が空の payload は中継しない。
- SPEC-SENDFILE-RELAY-002 — 中継するファイルは Concordia の添付上限 (10 件) で切る。
- SPEC-SENDFILE-RELAY-003 — 添付が拒否されたら、公開用の理由とファイル名をテキストとして同じチャンネルへ出し、絶対パスや外部応答本文は出さない。
