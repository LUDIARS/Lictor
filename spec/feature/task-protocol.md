# タスク宣言プロトコル

## 目的
セッションが「今どのブランチで何をしているか」を Concordia に宣言し、
ダッシュボード / 他セッションと共有 + 競合や保留タスクを skill として可視化する。

## 振る舞い
- **宣言**: `POST /v1/lictor/task {branch?, desc?}` → Concordia session を `PATCH` +
  event 発火 + `lictor-current-task` skill を更新
  ([`../../src/task-relay.ts`](../../src/task-relay.ts))。
- **取得**: `GET /v1/lictor/task` で `{branch, desc, updatedAt}`。
- **状態**: `GET /v1/lictor/state` で `{notify, conflict, task}`（ダッシュボード用）。
- **ポーリング由来の skill**（60s 周期）:
  - `lictor-pending-tasks` ← `GET /v1/sessions/<id>/pending-tasks`
    ([`../../src/pending-tasks.ts`](../../src/pending-tasks.ts))
  - `lictor-conflicts` + タイトル `⚠N` prefix ← `GET /v1/monitor/conflicts`
    ([`../../src/conflict-watcher.ts`](../../src/conflict-watcher.ts))

## 関連
新規 substantive 作業の着手時に宣言する運用（competing session 検知の土台）。
エンドポイントは [`../interface/sidecar-http-api.md`](../interface/sidecar-http-api.md)。
