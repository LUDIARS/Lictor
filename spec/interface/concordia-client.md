# Concordia クライアント契約

Lictor は Concordia（loopback `127.0.0.1:17330`、`CONCORDIA_HOST`/`CONCORDIA_PORT`
で変更可）に対する **クライアント** として振る舞う。`LICTOR_DISABLE_CONCORDIA=1`
で全連携を skip（v0.0 相当の単独動作）。呼び出しは best-effort で、失敗しても
ラッパ本体は継続する。実装は [`../../src/concordia.ts`](../../src/concordia.ts)。

## Lictor が依存する Concordia エンドポイント

| 用途 | Concordia 側 | タイミング |
|---|---|---|
| セッション登録 | `POST /v1/sessions` | 起動時（生成 session id + cwd + persona 要求） |
| 生存通知 | `GET /ws?session=<id>`（WS 接続維持） | 起動〜終了。切断で lost 判定、heartbeat POST 不要 |
| stat 送信 | `POST /v1/stat/<id>` | 10 分周期（git ブランチ/未push/未マージ等を収集） |
| chat 中継 | `POST /v1/chat` | `/v1/chat` 受信時 |
| 日報追記 | `POST /v1/reports/<id>/append` | `/v1/report` 受信時 |
| イベント | `POST /v1/sessions/<id>/event` | `/v1/event`・タイトル更新・タスク宣言時 |
| 競合確認 | `GET /v1/monitor/conflicts` | `/v1/conflicts` 受信時 + 60s ポーリング |
| pending tasks | `GET /v1/sessions/<id>/pending-tasks` | 60s ポーリング（`lictor-pending-tasks` skill 反映） |
| Discord channel | `GET /v1/sessions/<id>/discord-channels` | 起動時（session/meta channel id を保持） |
| タスク宣言 | `PATCH /v1/sessions/<id>`（branch/desc） | `/v1/lictor/task` 受信時 |
| 終了 | `DELETE /v1/sessions/<id>` | 終了時（`report` フィールドを受領） |

## 注意
- Concordia の上記契約が壊れると Lictor の互換面に影響する。Concordia 側の
  破壊的変更時は Lictor の対応バージョンを bump する。
- Discord 中継は Lictor 仲介（anti-crosstalk）: Lictor が session/meta channel id を
  保持し、全 chat 中継に `session_id` + `discord_channel_id` を刻むため AI は
  セッション名を呼ばない。詳細は `Concordia/spec/feature/discord-lictor-relay.md`。
