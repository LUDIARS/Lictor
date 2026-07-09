# transcript リレー / pull

## 目的
ラップ中の CLI（Claude / Codex / ローカルLLM）の **transcript（JSONL）** を読み取り、
Discord リレーやダッシュボードへ転送・取得できるようにする。

## 振る舞い（[`../../src/transcript-tail.ts`](../../src/transcript-tail.ts)）
- 対象 JSONL を発見し claim ファイルで占有（複数候補がある場合に並走ラッパが
  別 JSONL を pick できる）。
- provider 差を吸収して frame 化（Claude / Codex / ローカルLLM JSONL の形式翻訳、
  `lineToFrame`）。ローカルLLM は `{ts, role, content}` を text/system frame 化する。
- **pull**: `GET /v1/transcript?limit=N&raw=0|1`。`limit` 1–500（既定 50）。
  `raw=1` はパース済オブジェクト、既定は slim `lineToFrame` frame。返却は
  `{path, available, total_lines, returned, frames|lines}`。transcript-tail 非活性
  （Concordia 無 / pty 無）時は **503**。
- **push**: fire-and-forget で Discord リレー等へ送る経路（best-effort）。

## discover / anti-crosstalk（束縛先の決め方）
tail 対象 JSONL を「別セッションの JSONL」 と取り違えると発話が別チャンネルへ混線する。
mtime 推測を避け、provider 種別ごとに **誤掴みが構造的に起きない** 束縛キーを使う:

- **Claude（hook 権威）**: SessionStart hook が実 `transcript_path` を state ファイルへ
  書き、それを権威ソースとして束縛。`/clear` ローテートも hook 再報告で追従。
- **Codex（session_meta 施錠）**: `~/.codex/sessions/` を全セッション共有で吐くため、
  初回に先頭 `session_meta` の `session_id` を読んで施錠し、以後その id の rollout
  だけを tail（`discoverCodex`）。id が無い rollout は filename 末尾 UUID を施錠キーに
  fallback。複数候補は mtime 一意最新のみ bind、同点は fail-loud（推測 bind しない）。
- **ローカルLLM / Ollama 系（filename 施錠, `usesFilenameSessionLock`）**: runner
  （Famulus 等）は `<sessionsDir>/<LICTOR_SESSION_ID>.jsonl` に書き、ファイル名の
  末尾 UUID が Lictor の session id そのもの。よって起動時に自分の session id を
  施錠キーとして **事前施錠** し、`discoverCodex` の施錠済み分岐で filename UUID が
  完全一致する 1 ファイルだけを exact bind する（session_meta も mtime 推測も不要）。
  同一 sessions dir に別セッションの JSONL が並んでも自分のファイルだけを掴む。
  session id から UUID が抽出できなければ事前施錠せず初回束縛にフォールバック。
  新しい Ollama 系 runner は `makeLocalLlmProvider()` を 1 回呼ぶだけで追加できる
  （[`../../src/provider.ts`](../../src/provider.ts)）。

stall 復帰も同じ束縛キーで取り直す（Claude=権威 / Codex・ローカルLLM=施錠キー
discover / それ以外=pin）。いずれも mtime 推測で別セッションへ降りない。

## 注意
- 壊れた JSONL 行は捨て、空行は母数に含めない（`transcript-tail.test.ts` で固定）。
- dedup は message id（`msg_xxx`）基準。
