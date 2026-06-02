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
- なお `AskUserQuestion` の `tool_use` 行は picker 表示の瞬間（回答の数十秒〜
  数分前）に JSONL へ書かれるため、検知遅延は原因ではない（実 transcript で確認）。

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

## 劣化方針
- gate は純粋な状態機械（タイマ無し）。`tool_result` 検知が解放の主経路で、
  picker 解決は必ず `tool_result` を書くため、セッションが生きている限り
  恒久ロックしない。クラッシュ時は wrapper 終了 → `forceClear` で解放。
- Codex / Gemini provider は `AskUserQuestion` を持たないため gate は常に閉のまま
  （`providerSupportsAskUserQuestion` が false → open 呼び出しが発生しない）。
