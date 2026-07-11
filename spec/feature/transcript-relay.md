# transcript リレー / pull

## 目的
ラップ中の CLI（Claude / Codex / ローカルLLM）の **transcript（JSONL）** を読み取り、
Discord リレーやダッシュボードへ転送・取得できるようにする。

## 振る舞い
- App Server経路のCodexは、束縛済みthreadのeventを直接frame化し、JSONL discoveryを行わない。
- legacy/Claude/ローカルLLM経路は
  [`../../src/transcript-tail.ts`](../../src/transcript-tail.ts) で対象JSONLを発見・束縛する。
- provider 差を吸収して frame 化（Claude / Codex / ローカルLLM JSONL の形式翻訳、
  `lineToFrame`）。ローカルLLM は `{ts, role, content}` を text/system frame 化する。
- **pull**: `GET /v1/transcript?limit=N&raw=0|1`。`limit` 1–500（既定 50）。
  `raw=1` はパース済オブジェクト、既定は slim `lineToFrame` frame。返却は
  `{path, available, total_lines, returned, frames|lines}`。transcript-tail 非活性
  （Concordia 無 / pty 無）時は **503**。
- **push（現行legacy）**: fire-and-forget で Discord リレー等へ送る経路（best-effort）。
- **push（App Server target）**: session内で直列化し、HTTP statusと`persisted`を確認する。
  詳細はCodex初回sequence仕様のtranscript sink節に従う。

## discover / anti-crosstalk（束縛先の決め方）
tail 対象 JSONL を「別セッションの JSONL」 と取り違えると発話が別チャンネルへ混線する。
mtime 推測を避け、provider 種別ごとに **誤掴みが構造的に起きない** 束縛キーを使う:

- **Claude（hook 権威）**: SessionStart hook が実 `transcript_path` を state ファイルへ
  書き、それを権威ソースとして束縛。`/clear` ローテートも hook 再報告で追従。
- **Codex delegation（App Server 権威）**: `thread/start` 応答の `thread.id` と
  `thread.sessionId` を権威値として束縛し、同じ stdio 接続の event を直接 frame 化する。
  rollout discovery / tail は行わない。
- **Codex interactive（App Server 事前束縛）**: App Server で thread を事前作成し、
  `codex resume <thread.id>` を起動する。tail は事前指定された thread ID と完全一致する
  rollout だけを読む。mtime、cwd、filename UUID を所有権判定に使わない。
- **Codex legacy**: 現行の `session_meta` + mtime discovery は明示的な互換モードに隔離する。
  App Server 経路の失敗時に自動 fallback してはならない。
- **ローカルLLM / Ollama 系（filename 施錠, `usesFilenameSessionLock`）**: runner
  （Famulus 等）は `<sessionsDir>/<LICTOR_SESSION_ID>.jsonl` に書き、ファイル名の
  末尾 UUID が Lictor の session id そのもの。よって起動時に自分の session id を
  施錠キーとして **事前施錠** し、`discoverCodex` の施錠済み分岐で filename UUID が
  完全一致する 1 ファイルだけを exact bind する（session_meta も mtime 推測も不要）。
  同一 sessions dir に別セッションの JSONL が並んでも自分のファイルだけを掴む。
  session id から UUID が抽出できなければ事前施錠せず初回束縛にフォールバック。
  新しい Ollama 系 runner は `makeLocalLlmProvider()` を 1 回呼ぶだけで追加できる
  （[`../../src/provider.ts`](../../src/provider.ts)）。

stall 復帰も同じ束縛キーで取り直す（Claude=hook権威 / Codex=App Serverが返したthread ID /
ローカルLLM=施錠キー discover / それ以外=pin）。いずれも mtime 推測で別セッションへ降りない。

## 注意
- 壊れた JSONL 行は捨て、空行は母数に含めない（`transcript-tail.test.ts` で固定）。
- dedup は message id（`msg_xxx`）基準。

Codex thread の作成、最初の prompt 投入、最初の Concordia `transcript_logs` 永続化の前後関係は
[`codex-first-turn-transcript-sequence.md`](codex-first-turn-transcript-sequence.md) を参照。
