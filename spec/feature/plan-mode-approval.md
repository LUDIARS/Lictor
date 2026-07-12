# プランモード承認の Concordia リレー — 実装スペック (Codex 委託用)

対象リポ: この worktree (Lictor, origin/main 相当)。design=Claude / impl=Codex。
このスペック通りに実装し、末尾チェックリストの実行結果を PR 説明に貼ること。

## 目的

ラップ中の Claude Code が **プランモード**で `ExitPlanMode` を呼ぶと、ローカル TUI に
承認 picker が開くが、リモート (Discord/Web, Concordia 経由) からは答えられない。
既存の AskUserQuestion リレーと同じ経路で、プラン承認をリモート回答可能にする。

## 既存機構 (変更前に必ず読む — ほぼ再利用で済む)

- `src/ask-question-relay.ts`
  - `detectAskUserQuestion(line)` (:71) — transcript 行から `tool_use` name==="AskUserQuestion"
    を検出し `PendingQuestion[]` を返す (id = tool_use id)。
  - `detectAnsweredQuestionIds(line)` (:115) — `tool_result` の tool_use_id を返す
    (**generic なので ExitPlanMode の tool_result もそのまま拾える**)。
  - `postPendingQuestion` / `postResolveQuestion` — Concordia への登録/解決。
  - `providerSupportsAskUserQuestion` — claude のみ true (プランモードも claude 専用なので同じゲートで良い)。
- `src/transcript-tail.ts` — `detectAskUserQuestion` を呼び、検出時に
  `onQuestionOpen(id)` (inject ゲート) → `postPendingQuestion` → 登録された question_id を
  `onPickerQuestionRegistered(qid)` で wrap.ts に通知。 `tool_result` 観測で
  `onQuestionResolved(id)` + `postResolveQuestion`。
- `src/wrap.ts` `onAnswerQuestion` (:285) — 三分岐。分岐2 (`pickerQuestionIds`) が
  **picker への Down×N + Enter 注入** (`buildAnswerSequence(index+1)`)。
  ExitPlanMode の picker も同じ TUI 操作なので**この分岐がそのまま使える**。
- `tests/ask-question-relay.test.ts` — 検出関数のテスト前例。

## 実装タスク

### T1. ExitPlanMode 検出 (`src/ask-question-relay.ts`)
- `detectAskUserQuestion` と並ぶ `detectExitPlanMode(line): PendingQuestion[]` を追加。
  - `type==="assistant"` の `message.content[]` から `tool_use` で `name==="ExitPlanMode"` を検出。
  - `id` = tool_use id (local 解決の突合キー)。
  - `question` = `"プラン承認: このプランで進めますか?"` + `\n\n` + `input.plan` の先頭 **1500 文字**
    (string でなければ "(プラン本文なし)")。
  - `options` = 固定 3 択 (**Claude Code の picker と同順**):
    1. `承認 (auto-accept edits)`
    2. `承認 (編集は手動確認)`
    3. `却下 (プラン継続)`
  - `multiSelect` 相当は無し (単一選択)。既存 `PendingQuestion` 型に従う。
- 注意: picker の実オプション数/順序は Claude Code のバージョンで変わりうる。ラベルは
  上記の意味ラベルとし、**index がそのままローカル picker の並び順に対応する**前提を
  jsdoc に明記する (バージョン差異はリスクとして許容、検出側では吸収しない)。

### T2. transcript-tail への配線 (`src/transcript-tail.ts`)
- `detectAskUserQuestion(line)` を呼んでいる箇所で `detectExitPlanMode(line)` も呼び、
  結果を **同じ後続処理** (onQuestionOpen → postPendingQuestion → questionIdByToolUse 記録 →
  onPickerQuestionRegistered) に流す。配列 concat で済む形にする (処理の複製をしない)。
- `askUserQuestionEnabled` (provider ゲート) と同じ条件下でのみ動かす。
- local 解決 (tool_result) は既存の `detectAnsweredQuestionIds` 経路が generic なので**変更不要**
  — 変更不要であることをテストで固定する。

### T3. テスト (`tests/ask-question-relay.test.ts` に追記 + 必要なら transcript-tail 側)
1. `detectExitPlanMode`: ExitPlanMode tool_use 行 → PendingQuestion 1 件 (id/question 先頭/3 options)。
2. plan が 1500 文字超 → question が切り詰められる。
3. `input.plan` 欠落 → "(プラン本文なし)" で登録される (検出は落とさない)。
4. AskUserQuestion 行 / 無関係 tool_use 行 → `detectExitPlanMode` は空配列。
5. `detectAnsweredQuestionIds` が ExitPlanMode の tool_result 行から id を返す (現行のままで通ることの固定)。
6. transcript-tail 経由の統合: ExitPlanMode 行を書いた JSONL を tail し、
   `onQuestionOpen` が tool_use id で呼ばれること (既存の AskUserQuestion 統合テストがあれば
   その形を踏襲。無ければ検出関数の単体で可 — その場合は T2 の配線を目視でなく
   `grep detectExitPlanMode src/transcript-tail.ts` で checklist 判定)。

### T4. ドキュメント
- `spec/feature/askquestion-pending-gate.md` (または関連 spec) に「ExitPlanMode も同経路」を 1 段落追記。
- 本ファイル (このスペック) はリポに残してよい (spec/feature/ は正規分類)。

## 禁止事項 (anti-stub)
- wrap.ts の `onAnswerQuestion` 三分岐は**変更しない** (分岐2 が既に汎用)。
- `postPendingQuestion` / Concordia API 形状を変えない。新規エンドポイントを作らない。
- 検出を transcript-tail 内へ直書きしない (ask-question-relay.ts に置く — SRP)。

## 完了チェックリスト (PR 説明に結果を貼る)
1. `grep -n "detectExitPlanMode" src/ask-question-relay.ts src/transcript-tail.ts` → 両方に存在。
2. `grep -n "ExitPlanMode" tests/ask-question-relay.test.ts` → テストあり。
3. `npm test` → 既存含め green (既知の環境依存 1 件 `tests/active-repos.test.ts` は失敗可 — E: ドライブ起因、PR に明記)。
4. `npm run typecheck` → エラーなし。
5. `npm run build` → 成功。
6. wrap.ts の diff が無いこと (`git diff --stat origin/main -- src/wrap.ts` → 0)。

## ブランチ/PR
- この worktree 内で `feat/plan-mode-approval-relay` を切って commit → push → PR。
- merge 後の dist ビルドは呼び出し元 (Claude) が行うので不要。
