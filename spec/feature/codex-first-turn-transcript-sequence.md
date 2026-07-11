# Codex App Server によるセッション束縛と初回 transcript 永続化

## Status

- Decision: accepted
- Implementation owner: Opus
- Scope: Lictor が起動する Codex の初回 session/thread 束縛、delegation 実行、初回 `transcript_logs` 永続化
- Official references:
  - [Codex App Server](https://learn.chatgpt.com/docs/app-server)
  - [Codex CLI `resume`](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

## 結論

Codex の所有権判定に rollout の mtime、cwd、最新ファイル、先頭 user message を使わない。
Lictor は Codex セッションを必ず App Server の `thread/start` で先に作成し、その応答の
`thread.id` と `thread.sessionId` を権威値として束縛する。

- delegation: App Server の stdio JSON-RPC 接続上で `turn/start` を実行する。PTY/TUI と
  rollout tail は使用しない。
- interactive: App Server で thread を事前作成してから、既知の `thread.id` を指定して
  `codex resume <thread.id>` を PTY 起動する。transcript tail は同じ ID の rollout だけを読む。
- App Server が利用できない、認証できない、thread を確定できない場合は fail-closed とし、
  自動的に mtime discovery へフォールバックしない。

App Server はローカル stdio transport のみを使用する。experimental な WebSocket transport は
本実装の依存にしない。

## 解決する問題

現行実装は `~/.codex/sessions/` の共有ディレクトリから cwd と mtime を使って rollout を選ぶ。
同じ cwd で delegation と interactive session が並行起動すると、別プロセスが作成した rollout を
選択できる。先頭 `session_meta` から session ID を読めても、そのファイルが当該 Lictor 起動に
属することは証明できない。

誤束縛後に ID をロックしても誤りを固定するだけであり、claim ファイルも候補選択後の排他なので
所有権の証明にはならない。本設計は候補探索そのものを所有権判定から除外する。

## ID モデル

次の ID を混同しない。

| ID | 発行元 | 用途 |
|---|---|---|
| `lictor_session_id` | Concordia | transcript、通知、UI の配送先 |
| `codex_thread_id` | App Server `thread.id` | `turn/start`、`resume`、イベント相関、rollout exact match |
| `codex_session_id` | App Server `thread.sessionId` | Codex session tree の root。fork では thread ID と異なり得る |
| `turn_id` | App Server `turn.id` | 1回の依頼と approval/event の相関 |
| `item_id` | App Server item | transcript dedup と tool/message lifecycle の相関 |

`thread.id` と `thread.sessionId` は必ず応答から保存し、相互に導出しない。root thread では通常同値だが、
その性質を実装上の前提にしない。

## 状態機械

```text
STARTING
  -> APP_SERVER_READY
  -> AUTHENTICATED
  -> THREAD_BOUND
  -> BINDING_PERSISTED
  -> DELEGATION_RUNNING | INTERACTIVE_RUNNING
  -> COMPLETED | FAILED
```

安全上の不変条件:

1. `THREAD_BOUND` より前に Codex transcript を Concordia へ送らない。
2. `BINDING_PERSISTED` より前に delegation の `turn/start` または interactive TUI を開始しない。
3. すべての App Server notification は `threadId` が束縛済み `codex_thread_id` と一致する場合だけ処理する。
4. rollout tail は事前指定した `codex_thread_id` の exact match だけを許可する。
5. timeout、process exit、JSON-RPC error、ID 不一致では処理を停止し、自動 legacy fallback を行わない。
6. 認証トークン、環境変数、未変換の raw App Server message を transcript や通常ログへ出さない。

## 共通 bootstrap

1. Concordia に Lictor session を登録し、`lictor_session_id` を取得する。
2. `codex app-server --listen stdio://` を子プロセスとして起動する。
3. stdin/stdout を newline-delimited JSON-RPC transport として接続する。
4. `initialize` を送り、成功後に `initialized` notification を送る。
5. `account/read` で認証状態を確認する。
   - `account.type=chatgpt`: ChatGPT subscription の Codex 枠を使用する。
   - `account.type=apiKey`: API key 課金を使用する。
   - `account=null` かつ `requiresOpenaiAuth=true`: `codex_auth_required` で停止する。
   - delegation 中に login UI は開始しない。利用者は通常の Codex login または明示的な setup で認証する。
6. `thread/start` を `cwd`、model、sandbox/approval 設定、`serviceName="lictor"` とともに送る。
7. 応答の `thread.id` と `thread.sessionId` を保存する。同内容の `thread/started` notification は
   整合性確認に使い、不一致なら停止する。
8. Concordiaへ次の binding frame を `seq=0` で直列送信し、2xx と `persisted=true` を確認する。

```json
{
  "kind": "raw",
  "payload": {
    "type": "codex_session_bound",
    "codex_thread_id": "<thread.id>",
    "codex_session_id": "<thread.sessionId>",
    "transport": "app-server"
  }
}
```

9. binding frame の永続化確認後に実行経路へ進む。

## Delegation 経路

delegation では bootstrap に使用した App Server process と stdio connection を維持する。

1. `CONCORDIA_DELEGATION_PROMPT_FILE` を従来と同じ sanitize/size limit で読み込む。
2. `turn/start` に `threadId=codex_thread_id` と text input を渡す。
3. 応答の `turn.id` を保存する。
4. notification を allowlist 変換し、共有 transcript sink へ直列投入する。
5. `turn/completed` の final status が成功なら完了、`failed`/`interrupted` なら理由付きで失敗とする。
6. process stdin を閉じ、正常終了を待つ。終了待ち timeout 時のみ子プロセスを停止する。

delegation では以下を使用しない。

- PTY/TUI
- prompt body + delayed CR の二段書き
- submit watchdog
- rollout discovery / claim / tail
- mtime、cwd、filename UUID による session 推測

### Approval と質問

初期実装では delegation の `approvalPolicy` を明示設定し、既定値を `never` とする。sandbox は
workspace write の境界を維持する。App Server から server-initiated approval、permission、
`tool/requestUserInput` が届いた場合は自動承認しない。

- 対応する Concordia UI/契約がある要求だけ転送する。
- 未対応要求は `decline` または `cancel` を応答し、typed event を記録する。
- 応答せずに turn を永久停止させない。
- `acceptForSession` を暗黙に選ばない。

Approval proxy の拡張は別タスクにできるが、未対応要求を安全に終了させる処理は本実装に含む。

## Interactive 経路

1. binding frame 永続化後、bootstrap App Server connection を閉じる。
2. `codex resume <codex_thread_id>` を従来どおり PTY で起動する。
3. transcript tail を `expectedCodexThreadId=codex_thread_id` 付きで開始する。
4. tail は `session_meta` の ID が完全一致する rollout だけを bind する。ID 不明、parse failure、
   複数の別 ID、mtime 最新候補への fallback は許可しない。
5. 同じ thread ID の rollout rotation/resume は許可するが、別 ID へは移動しない。

App Server が作成した thread を対話 `codex resume` で開けること、初回 rollout と resume 後 rollout の
関係、終了時の cleanup は実 Codex CLI を使う compatibility test で固定する。互換性が確認できない
Codex version では interactive 起動を fail-closed とし、delegation の安全性を下げない。

## App Server event から transcript frame への変換

増分deltaは画面表示に利用できるが、永続 transcript の権威は原則 `item/completed` とする。

| App Server event/item | frame |
|---|---|
| `item/completed: userMessage` | `kind=text`, `payload.role=user` |
| `item/completed: agentMessage` | `kind=text`, `payload.role=assistant`, phaseを保持 |
| `item/completed: reasoning` | `kind=thinking`。公開可能なsummaryのみ |
| `item/completed: commandExecution` | `kind=tool`。command/status/exitCodeをallowlist |
| `item/completed: fileChange` | `kind=tool`。statusと対象pathの要約のみ |
| `turn/started`, `turn/completed` | `kind=raw` の制御frame |
| `error` | `kind=raw` のtyped error。tokenやrequest bodyは含めない |

dedup key は可能な限り `(codex_thread_id, turn_id, item_id, event_phase)` とする。同一 item の delta と
completed を両方永続化して本文を重複させない。未知の item type は本文を転送せず、type と安全な key
一覧だけを raw frame にする。

## transcript sink

App Server と rollout tail は同じ sequencer/sink を使用する。

- `seq` は Lictor session ごとに0から単調増加する。
- 同時POSTをせず、1件ずつ順序どおり送る。
- 2xx、レスポンスJSON、`persisted` を確認する。
- 一時失敗は上限付き exponential backoff で再送する。
- `(lictor_session_id, seq)` の重複応答は冪等成功として扱えるようConcordia契約を確認する。
- 永続失敗時は後続frameを追い越させず、sessionを degraded/failed として通知する。
- queue上限を設け、無制限にメモリを消費しない。

`seq=0` の binding frame が最初の `transcript_logs` であり、最初の user message は通常 `seq=1` 以降になる。

## JSON-RPC client 要件

- stdout chunk がJSONLの行境界と一致する前提を置かず、改行までbufferする。
- request idごとに pending promise、timeout、resolve/reject を管理する。
- response、notification、server-initiated requestを区別する。
- stderrは診断用だが、secret redaction後にのみLictor logへ出す。
- malformed JSON、duplicate response id、unknown response id、child exitをtyped error化する。
- cleanup時にpending requestをすべてrejectし、timer/listenerを解放する。
- unknown notificationは無視せず、安全なtype名だけをdebug記録する。

推奨モジュール境界:

```text
src/codex-app-server-client.ts   JSON-RPC transport/process lifecycle
src/codex-session-bootstrap.ts   auth/thread start/binding state machine
src/codex-event-frames.ts        allowlist event -> transcript frame
src/transcript-sink.ts           ordered POST/ack/retry/sequencing
src/wrap.ts                      delegation/interactive route selection
```

既存ファイルを同等の責務に整理できるなら、ファイル名はこの案に固定しない。

## 設定と移行

```text
LICTOR_CODEX_TRANSPORT=app-server|legacy
LICTOR_CODEX_APP_SERVER_BOOT_TIMEOUT_MS
LICTOR_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS
```

- target default は `app-server`。
- `legacy` は明示的な緊急退避用で、警告を出す。
- app-server選択後の実行時エラーで自動legacy fallbackしない。
- delegation の legacy 自動注入は互換期間後に削除する。
- rollout mtime discovery は既存sessionの互換読み取り用途へ縮小し、新規Lictor sessionの所有権判定には使わない。

## エラーコード

最低限、次を区別してConcordiaへ通知する。

| code | 条件 |
|---|---|
| `codex_app_server_start_failed` | processを起動できない |
| `codex_app_server_protocol_error` | initialize/JSON-RPC/ID整合性異常 |
| `codex_auth_required` | OpenAI認証が必要 |
| `codex_thread_start_failed` | thread/start失敗またはID欠落 |
| `codex_binding_persist_failed` | seq=0を永続化できない |
| `codex_turn_start_failed` | delegation turn/start失敗 |
| `codex_turn_failed` | turn/completedがfailed |
| `codex_approval_unsupported` | 未対応approval/requestを拒否した |
| `codex_resume_failed` | interactive resume起動または互換性確認失敗 |

## 実装順序

1. JSON-RPC client と fake App Server tests。
2. auth確認、`thread/start`、ID保存、binding frame 永続化。
3. delegation を App Server `turn/start` と event relayへ移行。
4. ordered transcript sink と失敗通知。
5. interactive の pre-create + `codex resume <ID>`、exact-ID tail。
6. legacy mtime pathをfeature flag配下へ隔離。
7. 実Codex CLI compatibility testと並行起動試験。

## 受入条件

- 同一cwdで2つ以上のLictor/Codexを同時起動しても、それぞれ異なる `codex_thread_id` に束縛される。
- delegationとinteractiveを同時起動しても、他sessionのuser/assistant/tool frameが混入しない。
- 新規app-server経路ではrollout候補のmtime比較を一度も行わない。
- `thread/start`応答前およびbinding frame永続化前にpromptを送らない。
- App Server eventのthread ID不一致を検出すると、frameを送信せずsessionを失敗させる。
- ChatGPT managed authでPlus/Pro等のplan typeを認識し、API keyを要求せず実行できる。
- auth tokenとraw request bodyが通常ログ、transcript、Discord通知に含まれない。
- App Server停止、timeout、壊れたJSON、重複response、未対応approvalでhangしない。
- transcriptのseq順とDB永続順が一致し、`seq=0` binding frameのpersist成功をテストできる。
- app-serverエラー時にlegacy/mTime discoveryへ自動fallbackしない。

## 必須テスト

### Unit

- stdoutのpartial line、複数行chunk、CRLF、malformed JSON。
- interleaved response/notification/server request。
- request timeout、child exit、cleanup、pending request reject。
- auth mode: chatgpt/apiKey/null。
- `thread.id` / `thread.sessionId` 欠落・不一致。
- event allowlist、unknown item、secret redaction、dedup。
- ordered sinkのretry、queue limit、persisted確認。

### Integration with fake App Server

- bootstrapからseq=0永続化まで。
- delegation turn、user/assistant/tool、turn completed。
- 異なるthread IDのnotification注入を拒否。
- approval/requestを安全にdeclineしてturnを終了。
- 2並列sessionのイベントが相互に混ざらない。

### Compatibility with installed Codex CLI

- ChatGPT managed authの `account/read`。
- `thread/start`で得たIDを `codex resume <ID>` で開ける。
- exact-ID rollout tailとresume/rotation。
- 同一cwdでdelegation + interactive + 通常Codexを並行起動するstress test。

実Codexを使うtestは認証や利用枠に依存するため、通常unit testとは分離し明示実行にする。

## 対象外

- App Server WebSocket transportの採用。
- Lictor独自のChatGPT token保管。
- Codex外でのsubscription利用枠回避。
- 全App Server item typeのraw転送。
- 未対応approvalを自動承認する仕組み。
