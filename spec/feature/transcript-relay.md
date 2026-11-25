# transcript リレー / pull

## 目的
ラップ中の CLI（Claude / Codex / Grok / agy / ローカルLLM）の transcript を読み取り、
Discord リレーやダッシュボードへ転送・取得できるようにする。

## 振る舞い
- App Server経路のCodexは、束縛済みthreadのeventを直接frame化し、JSONL discoveryを行わない。
- legacy/Claude/Grok/ローカルLLM経路は
  [`../../src/transcript-tail.ts`](../../src/transcript-tail.ts) で対象JSONLを発見・束縛する。
- provider 差を吸収して frame 化（Claude / Codex / Grok / ローカルLLM JSONL の形式翻訳、
  `lineToFrame`）。ローカルLLM は `{ts, role, content}` を text/system frame 化する。
- **pull**: `GET /v1/transcript?limit=N&raw=0|1`。`limit` 1–500（既定 50）。
  `raw=1` はパース済オブジェクト、既定は slim `lineToFrame` frame。返却は
  `{path, available, total_lines, returned, frames|lines}`。transcript-tail 非活性
  （Concordia 無 / pty 無）時は **503**。
- **push（現行legacy）**: fire-and-forget で Discord リレー等へ送る経路（best-effort）。
- **push（App Server target）**: session内で直列化し、HTTP statusと`persisted`を確認する。
  詳細はCodex初回sequence仕様のtranscript sink節に従う。

## Grok CLI transcript

Actio `actio:9f0725c9-83bd-4c89-bf15-2b3d67732eb5`

- Grok CLI 1.0.92 の `updates.jsonl` を監視する。パスは
  `<GROK_HOME または ~/.grok>/sessions/<encodeURIComponent(path.resolve(cwd))>/<UUID>/updates.jsonl`。
- 新規セッションには Lictor が `--session-id <UUID>` を渡し、対応するファイルの作成を待つ。
  `-s` または `--session-id` が指定されている場合はその UUID を使う。
  ID を伴わない再開・継続・フォーク指定では、起動時刻に近い候補を既存の discovery で探し、
  一度束縛した UUID で以後の探索を絞る。他の JSONL ファイルは探索対象から外す。
- `session/update` と `_x.ai/session/update` の user・assistant 本文、思考の先頭 400 文字、
  ツール呼び出しと終端結果を既存のフレーム形式で中継する。制御イベントと途中のツール更新は省く。

## agy SQLite reader

Actio `actio:6719398b-e0f9-4a6f-9cec-a328756c97db`

2026-11-21 に、agy が注入された指示を処理した後も Concordia の transcript は
0 件で、Discord に応答と入力確認が表示されなかった。agy は JSONL の監視対象外だった。

- Concordia 連携中の `lictor agy` は既存の対話 PTY を使う。ACP は stdio サーバー、
  `-p --output-format stream-json` はヘッドレス実行で、どちらも端末での対話と
  既存の注入経路を変える。SQLite を使う構成では両方を維持できる。
- Lictor が起動ごとに渡す `--log-file` の `Streaming conversation <UUID>` を照合する。
  `~/.gemini/antigravity-cli/cache/last_conversations.json` の起動 cwd と、起動時刻以降に
  作られた同一 ID の `presence/<UUID>.lock` がそろった場合に
  `conversations/<UUID>.db` を束縛する。束縛中はログと lock の同一性を確認する。
  同じ cwd で並走してキャッシュが先に上書きされた場合、中継は条件がそろうまで保留する。
  明示された `--log-file` は利用者の指定を優先し、その起動の中継は無効になる。
- Node.js 標準の `node:sqlite` で DB を読み取り専用で開き、WAL のコミット済み行を
  `steps.idx` 順に取得する。起動時刻以前のプロンプトに属する履歴は送らない。
  完了した step 14 の本文は既存の user フレームと入力確認経路へ渡す。共有
  `history.jsonl` は会話 ID を持たないため使わない。
- step 15 は既知の protobuf フィールドから表示用本文を取り出す。step 132 はツール名・
  呼び出し ID のみを送る。ツール引数、出力、内部推論、未対応の protobuf 形式は中継しない。
  pull API の `raw=1` には正規化済みのフレームを返す。
- 最終回答には、現在の入力に続く完了済み step 15 を使う。予定または後続のツールや
  モデル処理がある場合は途中経過として扱う。後続の入力が始まった時点、
  または同じ PTY の OSC 7501 `working → done` を受けた時点で最終回答を確定する。
  OSC が受信できないときは、表示用応答が DB に書かれ、後続処理が見つからず、
  同じ状態を 2 秒以上観測できた場合に確定する。
- JSONL 向けの終了時アーカイブには SQLite 本体を渡さない。最終応答の保証は
  agy のログと保存形式に依存する。対応する形式が変わった場合は読めない行を保留または
  スキップする。外部プロセスや新規ライブラリは追加しない。

[Antigravity CLI コマンド](https://antigravity.google/docs/cli/reference/)
・[Antigravity のリリースノート](https://antigravity.google/docs/changelog/)

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
- **Grok**: CLI に渡した UUID がある場合は対応するファイルだけを読む。再開などで UUID が
  未指定の場合は、`updates.jsonl` の親ディレクトリの UUID を初回束縛後の照合に使う。
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

## SPEC-ASK-MARKER-ACTIVATION: 検出可否と steering 注入の分離

- Concordia 連携中の Codex は、session-scoped `SkillInjector` の有無にかかわらず ask
  マーカー検出を有効にする。ルールをモデルへ伝える仕組みと transcript の検出能力は別の
  capability として扱い、一方の不在で他方を無効にしない。
- 判定は provider 名 / Concordia 有無 / injector 有無だけに依存する純関数に置き
  （[`../../src/ask-marker-activation.ts`](../../src/ask-marker-activation.ts)）、
  起動時に provider・enabled・reason を必ずログへ出す（無効化は無言で起きない）。
- **Cc spawn の Claude では組み込み `AskUserQuestion` をツールごと外す**
  （`--disallowedTools AskUserQuestion`）。判定材料は enrollment（`CONCORDIA_SPAWN_ID`）の
  有無だけで、これも純関数（`askUserQuestionDisableArgs`）に置く。system prompt 追記は
  soft な指示にすぎず、Claude Code 既定の「判断に迷ったら AskUserQuestion」と競合したとき
  負けることがある。picker は Discord / Slack のリレー越しには押せないため、開いた時点で
  セッションは無言で停止する（2026-09-05 の委託子セッション、2026-09-07 の
  `lictor-2a7dc3e9`）。
- enrollment を持たない起動は**人間が端末の前にいる**対話セッションなので picker は
  普通に答えられる。ここでツールを外すのは利便性を削るだけなので付けない。
- 追記プロンプトの文言は**ツールを実際に外したかどうかと必ず一致させる**
  （`claudeAskMarkerSystemPrompt(askUserQuestionDisabled)`）。ツールを外した Cc spawn では
  「**使えません。ask マーカーだけが回答経路です**」と事実を述べる（禁止の言い回しは既定
  プロンプトとの綱引きになるが、能力が無いという記述は競合しない）。ツールを外していない
  対話起動では picker は実際に動くため、同じ文言を渡すとモデルに嘘を与えることになる。
  そちらは「リレー越しには届かないので ask マーカーを使う」という soft な誘導に留める。

- ツールを外した起動では **picker を開かせずに deny する**。PreToolUse hook
  (`lictor cli ask-question-hook`) が質問を Concordia へ流した直後に
  `permissionDecision: "deny"` を返す。質問はユーザに届いているので、deny しても
  聞けなくなることはない。deny の文面には「送信済み / 聞き直すな / ターンを閉じて待て」を
  含める — 単に拒むとモデルは ask マーカーで同じことを聞き直し、質問カードが 2 枚出る。
- deny してよいのは **質問が実際に Concordia へ登録できたときだけ**。sidecar は
  deny する起動に限り pending-question の投稿完了を待ち、1 件も登録できなければ
  `ask_user_question_disabled: false` を返して picker を開かせる。deny の文面は
  「送信済みだから待て」と言い切るので、登録が落ちたまま deny すると質問がどこにも
  出ないままセッションが無言で止まる (この節が潰そうとしている事故そのもの)。
  picker を開かせる起動では従来どおり待たない (fire-and-forget)。
- deny した質問は **picker 経路に載せない**。`onPickerQuestionRegistered` と
  `onQuestionOpen` を呼ばず、回答は Concordia 起源の質問と同じ**テキスト注入**で返す。
  存在しない picker に Down+Enter を打たず、開くはずのない picker を待つ gate も作らない
  (gate が開いたままだと人間の 🙄 force-enter まで保留される)。
- ExitPlanMode は deny の対象外なので従来どおり picker として扱う。
- sidecar 応答が壊れている / 旧版で `ask_user_question_disabled` を返さない場合は
  **fail-open** (従来どおり picker を開く)。hook の不調でセッションを固めない。

## SPEC-ASK-MARKER-RELAY-CONTRACT: ask マーカーの中継契約

- Lictor は正常な ask マーカーを transcript 本文から消費し、散文があれば先に通常本文として
  中継したうえで、構造化した質問を pending-question API へ1回だけ投稿する。登録に失敗した
  場合は質問部分を raw ask として通常経路へ戻し、Concordia の fail-loud 表示へつなぐ。
- 生の ask マーカーが Concordia の transcript relay まで到達した場合は正常系ではない。
  Concordia はそれを黙って除去せず、回答可能な fail-loud 本文として残す。

Codex thread の作成、最初の prompt 投入、最初の Concordia `transcript_logs` 永続化の前後関係は
[`codex-first-turn-transcript-sequence.md`](codex-first-turn-transcript-sequence.md) を参照。
