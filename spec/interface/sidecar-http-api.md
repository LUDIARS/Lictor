# sidecar HTTP API

各 Lictor セッションは **loopback (`127.0.0.1`) のみ** で HTTP sidecar を listen
する（port は子プロセスに `LICTOR_PORT` で渡る）。全ハンドラは loopback ガードを
最初に通す（非ループバックは拒否）。Body cap 64 KiB、タイトル長 200 文字
（C0/DEL を除去後）。実装は [`../../src/sidecar.ts`](../../src/sidecar.ts)。

## エンドポイント

| Method | Path | Body / Query | 動作 |
|---|---|---|---|
| GET | `/v1/health` | — | `{"ok":true}` |
| GET | `/v1/version` | — | `{"name":"lictor","version":"<semver>"}` |
| GET | `/v1/meta` | — | セッション meta + persona JSON |
| GET | `/v1/concordia/session` | — | `{session_id, persona, role_label, concordia_enabled, discord}`（`discord` = 保持中の Discord channel ids） |
| POST | `/v1/title` | `{text}` | OSC 0 発行 + 手動オーバーライド設定 |
| POST | `/v1/title/auto` | — | 手動オーバーライド解除（次 stat 周期で auto 再開） |
| POST | `/v1/rename` | `{text}` | claude TUI stdin に `/rename <text>\r` 注入（実セッション非ラップ時 503） |
| POST | `/v1/slash` | `{cmd, args?}` | 汎用 slash 注入 `/<cmd> <args>\r`。`cmd` 正規表現 `^[a-z][a-z0-9-]{0,40}$` |
| POST | `/v1/runtime/model-effort` | `{model, effort}` | CcのGenius確認後の切替。Claudeは同一 PTY への切替を直列化して`/model`→`/effort`を送信。Codex TUIは`/model`がpickerのため正確な遠隔指定をせず409 |
| POST | `/v1/keys` | `{data}` | 生キーストローク注入（C0 制御は `\t \n \r \b ESC` 以外除去、Ctrl-C はドロップ） |
| POST | `/v1/answer` | `{choice, escape_first?}` | `AskUserQuestion` picker 回答（`choice` 1-based, 1–50。Down×(choice-1)+Enter） |
| POST | `/v1/chat` | `{channel, text, author_label?, in_reply_to?, scope?}` | Concordia `/v1/chat` へ中継。`session_id` を権威付与 + 保持 `discord_channel_id` 解決 + `author_label` 自動補完（混線防止） |
| POST | `/v1/report` | `{monologue, role?}` | Concordia `/v1/reports/:id/append` へ日報独白を追記 |
| POST | `/v1/event` | `{kind, payload?, ts?}` | Concordia `/v1/sessions/:id/event` へ中継 |
| GET | `/v1/conflicts` | `?repo=&branch=` | Concordia `/v1/monitor/conflicts` へ中継（自身を除外） |
| GET | `/v1/skill` | — | 注入済 skill 名一覧 + claude が走査する dir |
| POST | `/v1/skill` | `{name, content}` | SKILL.md を書込/上書（claude が live-reload） |
| DELETE | `/v1/skill/<name>` | — | 注入 skill を削除 |
| GET | `/v1/lictor/task` | — | 現在タスク状態 `{branch, desc, updatedAt}` |
| POST | `/v1/lictor/task` | `{branch?, desc?}` | Concordia session を PATCH + event 発火 + `lictor-current-task` skill 更新 |
| POST | `/v1/shutdown` | `{reason?: string, archive?: boolean}` | Cc unregister → CLI 即時終了 → transcript flush（最大 5 秒）→ archive → sidecar 終了を開始。重複時は `{ok:true, already:true}` |
| GET | `/v1/lictor/state` | — | `{notify, conflict, task}` スナップショット |
| POST | `/v1/implementation-tools/bind` | `{cwd, task}` | repo/origin/branch/project codeをCcで自動解決し既存session bindingを更新 |
| POST | `/v1/implementation-tools/service` | `{service_code, action, note?}` | testing claim → Excubitor control → release を一括実行 |
| POST | `/v1/implementation-tools/review` | — | Revisor local PR を初回提出または再審査 |
| GET | `/v1/transcript` | `?limit=N&raw=0\|1` | ラップ中 CLI の transcript（Claude/Codex JSONL）。`limit` 1–500（既定 50）。`raw=1` でパース済オブジェクト、既定は slim frame。`{path, available, total_lines, returned, frames\|lines}`。transcript-tail 非活性時 503 |

## `/v1/internal/*`（hook 専用）

| Method | Path | Body | 動作 |
|---|---|---|---|
| POST | `/v1/internal/permission-check` | `{tool_name, tool_input?, permission_mode?, guard_result?}` | PreToolUse hook の橋渡し。**全 mode** で `{deferred:true}` を即返し観測のみ記録する（decision は出さない）。hook は Claude の許可判定より前に走るため、ここで判断すると settings.json が許可するものまでカードになる |
| POST | `/v1/internal/notification` | `{message, cwd?, claude_session_id?}` | Notification hook の橋渡し。許可待ち message のときだけ直前の観測と突き合わせて Concordia へ許可カードを出す。`{ok, kind, matched, posted, request_id}` |
| POST | `/v1/internal/ask-question` | `{questions}` | AskUserQuestion の早期投稿 |
| POST | `/v1/internal/permission-response` | `{request_id, decision, reason?}` | 許可回答。TUI の開いているダイアログへ打鍵（`{ok:true, via:"keystroke"}`）。カードは投稿から 10 分で失効し、遅延回答が無関係のダイアログを操作しない |

## セキュリティ不変条件
- 全エンドポイントは `127.0.0.1` バインド + ハンドラ先頭で loopback 検証。
- TUI へ書き込む系（rename/slash/runtime model-effort/keys/answer/permission-response）は
  注入前に必ずサニタイズ。許可回答は外部文字列を pty へ流さず、`permission-answer.ts` の
  固定シーケンス（Enter / ESC）だけを使う
  （C0/DEL 除去・先頭 `/` 除去で slash チェイン防止・長さ cap）。詳細は
  [`../feature/keystroke-injection.md`](../feature/keystroke-injection.md)。
- Concordia 依存は best-effort（落ちても 503 で劣化、stack trace を出さない）。
