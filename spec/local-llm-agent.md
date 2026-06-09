# Lictor ローカル LLM エージェント (`lictor local`) — 設計

## 動機

Concordia delegation を**ローカル LLM (Ollama / Gemma 等) に委託**したいが、
codex を OSS モードで包む経路 (`gamma` プリセット) は version 不整合・無反応・
重さで実用に達しなかった。12B クラスのローカルモデルには codex の重い
エージェントハーネスは過剰。

そこで **Lictor 自身に軽量チャットエージェントを内蔵**し、codex のガワが
やっていたこと (= 対話 + 文脈維持 + Concordia/Discord 連携) を**軽く代行**する。
ツール使用・自律ファイル編集はやらない (ローカル 12B が苦手な領域)。
「文脈を保ったまま喋れるローカル AI セッション」が目的。

## 全体像

`lictor local [args]` は新 provider。Lictor の wrap (`runWrapped`) はこれまで通り
**pty で「バイナリ」を包む**が、その binary は `lictor` 自身で、隠しサブコマンド
`lictor cli local-agent` (= REPL 本体) を起動する。

```
lictor local
  └─ runWrapped(provider=local)         ← Concordia 登録 / タイトル / Discord リレー / ask は既存 wrap から全継承
       └─ pty: lictor cli local-agent   ← 本 spec の REPL
            └─ Ollama /v1/chat/completions (文脈保持)
```

provider 設定 (`src/provider.ts`):
- `binary = "lictor"`、`spawnArgs = ["cli", "local-agent"]` (ProviderConfig に
  `spawnArgs?` を追加。wrap が user args の前に差す)
- `skillStrategy = "none"`、`concordiaProvider = "local-llm"`、`displayName = "Local LLM (Ollama)"`
- `submitInject = single-write` (REPL は 1 行 + Enter を stdin で受ける)
- `supportsSessionPin = false`、`transcriptDir`: 本エージェントの JSONL 置き場を返す

## 設定 (env)

| env | 既定 | 意味 |
|---|---|---|
| `LICTOR_LOCAL_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI 互換エンドポイント (Ollama) |
| `LICTOR_LOCAL_MODEL` | `gemma4:12b` | モデル |
| `LICTOR_LOCAL_API_KEY` | (なし) | 任意 (vLLM 等の Bearer) |
| `LICTOR_LOCAL_MAX_TOKENS` | `4096` | 1 応答の max_tokens (reasoning モデル空応答対策) |
| `LICTOR_LOCAL_TIMEOUT_MS` | `300000` | 1 応答待ちタイムアウト |
| `LICTOR_LOCAL_SYSTEM` | (なし) | system プロンプト (persona があれば前置) |
| `LICTOR_LOCAL_CONTEXT_TOKENS` | `131072` | 文脈窓の想定サイズ (compaction の基準) |
| `LICTOR_LOCAL_COMPACT_RATIO` | `0.75` | この割合を超えたら compaction |
| `LICTOR_LOCAL_HOOKS` | `~/.lictor/local-hooks.json` | hook 定義ファイル |
| `LICTOR_LOCAL_SESSIONS_DIR` | `~/.lictor/local-sessions` | transcript 置き場 |

## 1. 会話ログ (コンテクスト) の永続保存

`src/local-agent/transcript.ts`。

- 1 セッション = 1 JSONL ファイル `<sessions-dir>/<session-id>.jsonl`。
  session-id は `LICTOR_SESSION_ID` (Concordia 連携時) か `local-<uuid>`。
- 各 turn を append: `{ ts, role: "user"|"assistant"|"system", content }`。
  compaction イベントも `{ ts, role:"system", kind:"compaction", summary, dropped }` で残す。
- 起動時、同 session-id の既存 JSONL があれば **読み込んで messages[] を復元** (resume)。
  → プロセス再起動・別窓再開でも文脈が続く。
- 追記は行単位 fsync 不要の append (`appendFileSync`)。クラッシュしても直近行まで残る。

## 2. サイズ管理 + 閾値超過時のコンパクション

`src/local-agent/compaction.ts`。

- **トークン量推定**: 依存を増やさない (prebuilt-only 規約) ため、文字数ベースの
  ヒューリスティック (`ceil(chars / 4)` を上限寄りに、日本語は重めに係数) で
  messages[] の総量を推定する。正確なトークナイザは入れない。
- 各 turn 後に `estimateTokens(messages)` を計算。
  `> contextTokens * compactRatio` を超えたら **compaction** を起動:
  1. 直近 `keepRecent` 件 (既定 6) を残し、それより古い messages を集める。
  2. 古い塊を LLM に要約させる (同じ Ollama に「これまでの会話を箇条書きで要約」)。
  3. messages を `[system(persona), system("これまでの要約:\n" + summary), ...recent]` に置換。
  4. transcript に compaction フレームを追記 (要約 + dropped 件数)。
- 要約自体が失敗したら **古い塊を単純に切り詰める** フォールバック (要約なしでも
  プロセスは止めない)。
- 「弔辞」= 古い文脈に区切りをつけて要約として畳む処理。手動 `/compact` でも起動可。

## 3. hook 対応

`src/local-agent/hooks.ts`。LUDIARS の hook 生態系 (window-title / Concordia 等) に
乗るための最小ライフサイクル hook。Claude Code の hook 契約をサブセット模倣する。

- hook 定義 = JSON (`LICTOR_LOCAL_HOOKS`):
  ```json
  { "hooks": { "SessionStart": [{ "command": "..." }],
               "UserPromptSubmit": [{ "command": "..." }],
               "Stop": [{ "command": "..." }] } }
  ```
- イベント:
  - `SessionStart`: REPL 起動直後。
  - `UserPromptSubmit`: ユーザ入力を LLM に送る直前。**stdout 非空ならその文字列を
    追加コンテキストとして system メッセージに足す** (Claude 互換の additionalContext)。
  - `Stop`: LLM 応答完了後。
- 実行: `child_process.spawn(command, { shell:true })`、stdin に
  `{ hook_event_name, session_id, cwd, prompt? }` JSON、stdout を回収。
  タイムアウト (既定 10s) / 全エラーは握りつぶす (hook がセッションを止めない)。
- 環境変数 `LICTOR_PORT` / `LICTOR_SESSION_ID` は wrap が既に export 済なので、
  hook から sidecar / Concordia に到達できる。

## REPL ループ (`src/local-agent/repl.ts`)

1. SessionStart hook。
2. transcript 復元 → messages[]。空なら system (persona/env) を 1 件置く。
3. プロンプト記号を出して stdin を 1 行読む (raw な pty 入力。改行で確定)。
   - `/compact` → 手動 compaction。`/exit` `/quit` → 終了。`/help` → ヘルプ。
4. UserPromptSubmit hook → additionalContext 追記。
5. user メッセージを messages + transcript に追加。
6. Ollama /v1/chat/completions (stream) で応答を逐次 stdout に出力。
7. assistant メッセージを messages + transcript に追加。
8. Stop hook。
9. compaction 判定 (超えていれば畳む)。
10. 3 へ戻る。EOF / `/exit` で終了。

非対象 (将来): ツール使用 / ファイル編集 / Concordia transcript-tail への frame 中継
(本エージェントの JSONL は Concordia の claude/codex parser と形式が違うため、
relay は transcript-tail に local parser を足す別 PR)。

## テスト (`tests/*.test.ts`, node:test)

- `compaction.test.ts`: estimateTokens 単調性 + 閾値超で古い塊が要約 1 件に畳まれる
  (LLM 呼び出しは stub)。
- `transcript.test.ts`: append → 再読込で messages 復元。compaction フレーム往復。
- `local-hooks.test.ts`: UserPromptSubmit hook の stdout が additionalContext になる。
