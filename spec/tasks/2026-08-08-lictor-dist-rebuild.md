---
task: lictor-dist-rebuild
project: Lictor
kind: 雑用
status: pending
created: 2026-08-08
source_session: lictor-d56d4998-191c-49a3-a8b0-bc0a25f4b676
memoria_task_id: null
actio_task_id: null
memory_links: []
---

# permission-defer マージ後の dist 再ビルド

## 目的

`bin/lictor.mjs` は **`dist/cli.js` (コンパイル済み) を実行する**。 src を直しても
`npm run build` するまで新規セッションに反映されない。 permission-defer の修正は
sidecar の許可経路そのものなので、 dist が古いままだと「マージしたのに全ツール
呼び出しに 5 秒乗り続ける」旧挙動が残る。

過去に同じ理由で crosstalk が再発している (CLAUDE.md「デプロイの注意」参照)。

## 完了条件

- [ ] PR #339 (`feat/permission-defer`) がマージされている。
- [ ] `E:/Document/Ars/Lictor` (共有 checkout) で `npm run build` を実行した。
- [ ] 新規に spawn した Lictor セッションで、auto 承認される Read/Glob/Grep に
      5 秒の遅延が乗らないことを確認した。
- [ ] 既に起動中の wrapper はコードをメモリに載せているため、反映には該当セッションの
      Lictor 再起動 (`/co-relictor` or 再 spawn) が要ることを周知した。

## スコープ (編集可ディレクトリ)

- ビルド成果物のみ (`dist/`)。ソース変更を伴わない。

## 備考

- 動作確認は Discord の TestWorkflow フォーラムスレッドに記録する
  (Revisor 通知の指示)。
- worktree からサービスを起動しない (worktree-hygiene / cc-test 準拠)。
