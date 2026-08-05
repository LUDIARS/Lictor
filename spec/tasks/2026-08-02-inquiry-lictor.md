---
task: inquiry-lictor
project: Lictor
kind: 実装
status: pending
created: 2026-08-02T00:00:00.000Z
source_session: lictor-ba65b800-2ca3-44c3-80a9-1027125f8e42
memoria_task_id: 711
actio_task_id: null
memory_links:
  - E:/Document/Ars/.wt-Cc-inquiry/spec/feature/inquiry.md
  - E:/Document/Ars/.wt-Cc-inquiry/spec/feature/session-surface-project-codes.md
  - E:/Document/Ars/.wt-Cc-inquiry/spec/feature/session-shutdown.md
---
# お伺い / shutdown / active repo 報告 — Lictor 側

## 目的

2026-08-02 neco 指示の項目 1・2・4 のうち Lictor が担う部分を実装する。
設計正本は Concordia リポの 3 本の spec (上の `memory_links` の絶対パス。
`feat/inquiry-protocol` ブランチの worktree にある)。
**設計は確定済み。 spec に書いてあることをそのまま実装する。**

Concordia 側の対応実装は別タスク
(`E:/Document/Ars/.wt-Cc-inquiry/spec/tasks/2026-08-02-inquiry-protocol.md`)。
先に Cc 側が入っていなくても Lictor 単体でビルド・テストが通るように書くこと
(Cc の新 API は呼び出し失敗を握りつぶす best-effort 扱いにする)。

## 完了条件

### L1. active repo を正準リポ root に解決して報告する (`session-surface-project-codes.md` §2.1)

- `src/active-repos.ts` に、 与えられたパスの **本体リポ root** を返す関数を足す。
  `git rev-parse --git-common-dir` を引き、 worktree なら本体側の root を得る。
  名前推測 (`<Project>-<何か>` の前方一致) は使わない。
- 失敗時 (git が無い / リポでない) は入力パスをそのまま返す (never-throw)。
- 結果はプロセス内でキャッシュする。 relay tick ごとに毎回 git を起動しない。
- `src/wrap.ts` の active-repo relay を直す:
  - `patchSession` に **`active_repos: string[]`** (解決済み・重複除去・出現順維持)
    を加えて送る。 `repo_path` は従来どおり「直近に触れたリポ」のまま変えない
    (既存の衝突判定・spawn 判定がこれに依存しているため)。
  - 送信条件を現行の `activeChanged` のみ から **`activeChanged || listChanged`**
    に広げる。 リストだけ増えた場合に Cc へ届いていないのが現在の不具合。

### L2. `POST /v1/shutdown` (`session-shutdown.md` §2.1)

- `src/sidecar.ts` に route を足す。 既存 route と同じ書き方に合わせる。
- 実行順は spec §2.1 の 1→4 を厳守する:
  1. Cc へ unregister (先にやる。 後回しにすると Cc に `lost` が残る)
  2. ラップ中の CLI プロセスを終了 (`forceExit()`。 graceful の 5 分待ちは通さない。
     ただし transcript sink の flush は最大 5 秒待つ)
  3. セッションログのアーカイブ (§L3)
  4. 自プロセス終了。 **レスポンスは 4 の前に返す**
- 異常系は spec のとおり: CLI が既に死んでいたら 2 を skip、
  アーカイブ失敗は `archived: null` + warn で**続行**、
  二重呼び出しは `{ ok: true, already: true }` で no-op。
- shutdown の順序制御は sidecar から独立したモジュールに切る (SRP・テスト可能に)。

### L3. セッションログのアーカイブ (`session-shutdown.md` §3)

- 出力先 `<workspace-root>/session-logs/archive/<YYYY-MM-DD>/<session-id>/`。
- 中身は spec §3 の表のとおり (`transcript.jsonl.gz` / `state/` / `meta.json`)。
- **元ファイルは移動ではなくコピー**する (Claude Code / Codex 側が掴んだままの可能性)。
- gzip 後 100MB 超は先頭・末尾 50MB ずつに切り詰め、 `meta.json` に
  `truncated: true` を書く。
- state dir の解決は既存の `resolveActiveReposDir()` を再利用する
  (`E:` 直書き禁止の既存方針を引き継ぐ)。

### L4. session-end スキルに shutdown ステップを足す (`session-shutdown.md` §2.2)

- `src/session-end-skill.ts` の `SESSION_END_SKILL_BODY` に、 独白 (現行の最終ステップ)
  の**後**に新ステップ「6. Lictor に shutdown を送る (最後・必須)」を足す。 文面は
  spec §2.2 のブロックをそのまま使う。
- 「やらないこと」節に「shutdown を送る前に新しい作業を始めない」を追記する。
- ポートは環境変数 / 既存の sidecar ポート解決から取る。 **ハードコードしない**
  (port-source-rule)。
- `E:/Document/Ars/.claude/commands/session-end.md` にも同じステップを足す
  (Claude Code の slash command 側)。 **このファイルだけはリポ外なので、
  編集してよい例外として明示する。**

### L5. 作業完了時のお伺い送信 (`inquiry.md` §6)

- セッションの作業完了を検知したら `POST <CC>/v1/inquiry`
  に `{ category: "タスク", context: <機械的に集めた現況> }` を送る。
- **完了の意味判断を Lictor に持たせない。** 検知は Cc の completion ブラックボックス
  の結果に従う (Cc から通知を受ける形にする)。 Lictor 側は送信役に徹する。
- `context` に詰めるのは Lictor が既に持っている機械的な材料だけ:
  active repo 群 / branch / 未 commit 差分の有無 / 直近の PR / 現在タスク。
- Cc が応答しない・404 を返す場合は握りつぶす (Cc 側未デプロイでも壊れないこと)。

## スコープ (編集可ディレクトリ)

- `E:/Document/Ars/.wt-Li-inquiry/src/`
- `E:/Document/Ars/.wt-Li-inquiry/tests/`
- `E:/Document/Ars/.wt-Li-inquiry/spec/`
- 例外: `E:/Document/Ars/.claude/commands/session-end.md` (L4。 このファイルのみ)

**Concordia リポは触らない** (別タスク)。

## 守ること

- **ブランチは `feat/inquiry-and-shutdown`、 作業ディレクトリは
  `E:/Document/Ars/.wt-Li-inquiry`。** 他のディレクトリ・ブランチで作業しない。
- SRP とファイル分割 (`/coding-conventions`)。 shutdown の順序制御・アーカイブ・
  git root 解決はそれぞれ別モジュールに切る。
- 1 行圧縮コードを書かない。 既存コードの整形に合わせる。
- **サービスの起動・再起動・動作テストはしない** (ハーネス deny)。
  ユニットテストは書いてよい。 Lictor は自分自身をラップしているので、
  実プロセスに対する shutdown の実行は**絶対にしない** (このセッションが死ぬ)。
- PR 作成まで。 マージしない。
- 既存コードは日本語コメントで「なぜ」を書く流儀なので、 それに合わせる。

## 完了報告

実装が終わったら PR を作り、 以下を報告する:

- 実装した L番号 と、 実装しなかったものがあればその理由
- shutdown の順序 (unregister → kill → archive → exit) をユニットテストで
  検証したか、 その方法
- L1 の git root 解決が worktree (`.wt-*`) と通常リポの両方で正しいことを
  どう確認したか
