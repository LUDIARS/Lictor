# Codex transcript tail が 0 件になる問題

日付: 2026-07-09

## 現象

Cc の Codex セッションで、Lictor/Cc の transcript tail が 0 件になり、Concordia 側の `transcript_logs` に地の文が流れない。

影響:

- Discord/Web から見る直近 transcript が空になる。
- `transcript.frame` が動かないため、Codex の応答進捗や inject ack の判断が遅延または不能になる。
- Claude では再現せず、Codex 固有の transcript discovery 問題として扱える。

## 原因

Lictor の Codex transcript discovery は、`~/.codex/sessions/**/rollout-*.jsonl` から候補を探し、先頭 `session_meta` の `session_id` を読めた候補だけを初回 bind 対象にしていた。

問題点:

- `session_meta.session_id` が読めない、またはメタ形式が揺れると候補が 0 件扱いになり、`jsonlPath` が決まらない。
- 同一 cwd に複数 rollout がある場合、初回 bind を `ambiguous` として拒否していた。
- Codex の resumed/spawned rollout では先頭 timestamp が古くても、ファイル mtime は spawn 直後に更新されることがある。従来は head timestamp を優先して候補除外しうる。

結果として `startTranscriptTail().readRecent()` は `jsonlPath = null` のまま `available:false / returned:0` を返す。

## 対応

Codex 専用の固定処理として、spawn セッション特定では mtime と rollout filename UUID を利用する。

- `session_meta` の ID 読み取りを `session_id` / `sessionId` / `conversation_id` / `thread_id` / `id` に拡張。
- `session_meta` に ID が無い場合、`rollout-...-<uuid>.jsonl` の末尾 UUID を施錠キーとして使う。
- 初回 bind 候補が複数ある場合、mtime が一意に最新の候補を bind する。
- mtime が同点、または mtime が無い場合は従来どおり `ambiguous` として推測 bind しない。
- head timestamp が古くても、mtime が Lictor 起動直近なら spawned/resumed rollout として候補に残す。
- 施錠後の再 discovery は、施錠キーまたは filename UUID が一致する rollout だけに限定し、別セッションへは降りない。

変更箇所:

- `src/provider.ts`
- `src/transcript-tail.ts`
- `tests/transcript-meta-filter.test.ts`
- `tests/transcript-tail.test.ts`

## 検証

通過:

- `node --test --import tsx tests/transcript-tail.test.ts tests/transcript-meta-filter.test.ts`
- `npm run typecheck`

追加した主なテスト:

- `session_meta` に ID が無くても filename UUID fallback で bind し、`readRecent()` が 0 件にならない。
- 複数 Codex rollout がある場合、mtime 最新を初回 bind する。
- mtime 同点なら ambiguous のままにする。
- 古い head timestamp でも fresh mtime なら候補として許可する。

補足:

- `npm test` 全体は 1 件失敗したが、今回の変更対象外である `tests/active-repos.test.ts` の環境依存失敗。現在の workspace が `E:` ドライブ上にあるため、`!/^E:/` を期待する既存テストが落ちている。

## 残リスク

Codex の同一 cwd で複数セッションがほぼ同時に同じ mtime で更新された場合は、意図的に bind しない。これは別セッション混線より tail 停止を優先するため。
