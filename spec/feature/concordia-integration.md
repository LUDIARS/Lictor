# Concordia 統合

## 目的
Lictor を Concordia（multi-agent セッション調整サービス）の sidecar として動かし、
セッションの登録・生存・現況共有・chat/report/event の中継を担う。

## 振る舞い（[`../../src/concordia.ts`](../../src/concordia.ts) ほか）
1. **登録** — 起動時に `POST /v1/sessions`（生成 session id + cwd + persona 要求）。
   返ってきた persona / role_label を env と meta に反映。
2. **生存** — `GET /ws?session=<id>` で WS 接続を維持。切断で lost 判定。
   heartbeat の POST は不要。
3. **stat ポーリング** — 10 分周期で git 現況（branch / 未push / 未マージ / 直近
   commit）を集めて `POST /v1/stat/<id>`（[`../../src/stat.ts`](../../src/stat.ts)）。
   active repo の変化時は、本体リポ root に正準化した `active_repos` も session PATCH
   で報告する（[`active-repo-reporting.md`](active-repo-reporting.md)）。
4. **中継** — `/v1/chat` `/v1/report` `/v1/event` `/v1/conflicts` を Concordia の
   対応 API へプロキシ（契約は [`../interface/concordia-client.md`](../interface/concordia-client.md)）。
5. **event reactor** — Concordia からの event（リモート注入 / タイトルマーク等）を
   受けて反映（[`../../src/event-reactor.ts`](../../src/event-reactor.ts)）。自セッションの
   completion 通知時だけ、機械的な現況を `/v1/inquiry` へ best-effort 送信する
   （[`task-inquiry.md`](task-inquiry.md)）。
6. **終了** — `/v1/shutdown` が WS を閉じ `DELETE /v1/sessions/<id>` を先に実行し、
   CLI 終了・archive 後に sidecar を終了する
   （[`session-shutdown.md`](session-shutdown.md)）。

## 劣化方針
Concordia 不在 / 接続失敗は best-effort。`LICTOR_DISABLE_CONCORDIA=1` で全 skip。
中継系は Concordia null 時に **503** を返す（500 にしない）。ユーザに stack trace を
見せない。

## 関連
chat の anti-crosstalk（session_id + discord_channel_id 付与）は
[`../interface/concordia-client.md`](../interface/concordia-client.md) と
`Concordia/spec/feature/discord-lictor-relay.md`。
