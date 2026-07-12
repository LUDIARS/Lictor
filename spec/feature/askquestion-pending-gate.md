# AskUserQuestion pending-gate（リモート回答中の inject 保留）

## 目的
Claude Code の `AskUserQuestion` picker が開いている間、通常の pty inject を
保留して picker の誤確定を防ぐ。これにより「Discord に質問が出る前に AI が
デフォルト選択肢で先に進んでしまう（=質問が事後に見える）」事象を解消する。

## 背景（根本原因）
- picker はモーダルな TUI リスト。フォーカス中の任意キーは候補ナビ/絞り込みに、
  Enter は選択確定として解釈される。
- Lictor がリモート入力を pty に流す経路は 2 系統:
  1. `onAnswerQuestion`（Discord/Web のボタン → Concordia `question.answered`
     → `(N-1)×Down + Enter`）。**これは回答そのもの**で、常に picker に届く必要がある。
  2. `onInject`（session channel への通常チャット / `/enter` / Codex の `\n`
     submit fallback → Concordia `session.inject` → `text + \r`）。
- 修正前は (2) が「picker が開いているか」を知らず、picker 表示中に届いた
  inject が `text + Enter` として picker に入り、**デフォルト/誤った候補を確定**
  していた。Concordia が直前に投稿した質問 embed は事後表示に見えた。
- ⚠️ **訂正 (2026-06-04)**: 旧記述では「`tool_use` 行は picker 表示の瞬間に
  JSONL へ書かれる」としていたが、 現行 Claude Code では **回答が確定してターンが
  閉じた時** に書かれる。 そのため transcript-tail 起点の Discord 早期投稿は
  **原理的に回答後**になり手遅れだった (= Discord から答えられない)。
  → 質問の Discord 投稿は **PreToolUse hook 起点**に変更した（下記「早期投稿」）。
  transcript-tail は引き続き gate と resolve (tool_result 検知) を担当する。

## 早期投稿（PreToolUse hook, 2026-06-04）

picker が**開く前**に発火する Claude Code の PreToolUse hook（matcher
`AskUserQuestion`）で質問を Concordia へ早期投稿する:

1. per-session settings に `lictor cli ask-question-hook` を PreToolUse として登録
   ([`../../src/wrap.ts`](../../src/wrap.ts) `writePermissionHookSettings`)。
2. hook は stdin の `tool_input.questions[]` を sidecar
   `POST /v1/internal/ask-question` に渡す（[`../../src/ask-question-hook.ts`](../../src/ask-question-hook.ts)）。
   decision は返さず picker をそのまま開かせる（権限ゲートではない）。
3. sidecar は `extractPendingQuestions` で変換し `postPendingQuestion` で Concordia に
   即投稿 → Discord に**回答前に**質問カードが出る。
4. transcript-tail も後追いで同じ質問を投稿するが、 Concordia 側が
   `(session, question)` で**冪等化**して同一 `question_id` に収束させるため重複しない。
   この冪等化により transcript-tail の `tool_use id → question_id` マップも正しく張られ、
   resolve / gate は従来どおり成立する。
- LICTOR_PORT 無し / sidecar 不達 / 例外時は hook が何もせず exit 0（picker を止めない）。

## 振る舞い（[`../../src/pending-question-gate.ts`](../../src/pending-question-gate.ts)）
1. **open** — transcript-tail が `AskUserQuestion` の `tool_use` を検知したら、
   その `tool_use` id で gate を開く（[`../../src/ask-question-relay.ts`](../../src/ask-question-relay.ts)
   `detectAskUserQuestion`）。複数 question を持つ 1 回の呼び出しは同一 id を共有。
2. **hold** — gate が開いている間、`onInject` は pty へ書かず FIFO キューに保留。
   `onAnswerQuestion`（回答キー）は gate を経由せず常に通す。
3. **close** — picker が解決（ローカル回答でもリモート回答でも）すると、同じ
   `tool_use` id を持つ `tool_result` が次行に現れる（実データで確認）。それを
   `detectAnsweredQuestionIds` が検知して gate を閉じ、保留 inject を FIFO で flush。
4. **force-clear** — wrapper 終了 / transcript-tail stop 時は保留を flush せず破棄
   （死にゆく pty / 追跡不能な picker への誤注入を避ける）。

`ExitPlanMode` も `detectExitPlanMode` で `PendingQuestion` に変換し、transcript-tail の
同じ後続処理（pending-question 投稿、`tool_use id → question_id` 記録、picker 回答キー注入）に
流す。ローカル picker の選択肢順と Concordia 側の選択肢 index が一致する前提で、wrap.ts の
既存 picker 分岐を再利用する。

## 劣化方針
- gate は純粋な状態機械（タイマ無し）。`tool_result` 検知が解放の主経路で、
  picker 解決は必ず `tool_result` を書くため、セッションが生きている限り
  恒久ロックしない。クラッシュ時は wrapper 終了 → `forceClear` で解放。
- Codex / Gemini provider は `AskUserQuestion` を持たないため gate は常に閉のまま
  （`providerSupportsAskUserQuestion` が false → open 呼び出しが発生しない）。

## ローカル回答時の Concordia 通知（local-resolve）
picker を端末キーボードで回答した場合、リモート（Discord/Slack）には回答が伝わらず、
投稿済みの古いボタンが残る。後からそれを押すと `onAnswerQuestion` がキー注入し、
picker が無い状態に stray 入力する恐れがある。これを防ぐため:
- `postPendingQuestion` の戻り値で Concordia の `question_id` を受け取り、transcript-tail が
  `tool_use id → question_id` を保持する。
- picker 解決（`tool_result` 検知）時、その question_id で
  `POST /v1/sessions/:id/pending-question/:qid/resolve` を best-effort 送信。
- Concordia は当該 pending-question を `answered_at` 付きにし（`markResolvedLocally`）、以後の
  `answer-question` / ボタン押下を弾く（stray 注入防止）。加えて `question.resolved` を emit し、
  Discord はボタンを除去（Slack は質問メッセージ ts 未保持のため将来対応）。
- リモート回答済みの場合は Concordia 側が既に answered のため resolve は idempotent な no-op。
