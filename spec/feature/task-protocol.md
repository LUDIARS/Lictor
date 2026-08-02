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

## TASK-CLI-ENTRYPOINT-BOUNDARY: CLI entrypoint の責務境界

対象ドメインは **session coordination / task declaration** とする。
`lictor cli task get/set` の責務は、短命な CLI entrypoint から sidecar の task API へ
宣言を中継するところまでであり、任意の観測基盤を初期化する責務は持たない。

- `task get/set` を含む短命な `lictor cli ...` は Vestigium を読み込まない。
- Vestigium の初期化は long-running provider wrapper と `cli local-agent` の起動境界に限定する。
- 観測 package や未追跡の build artifact が欠けても task declaration は利用可能であり続ける。
- Vestigium 自体の縮退条件と診断方法は [`../setup/setup.md`](../setup/setup.md) を正本とする。

これにより、session coordination の制御経路が observability のローカル build 状態へ
逆向きに依存しない境界を維持する。

## 関連
新規 substantive 作業の着手時に宣言する運用（competing session 検知の土台）。
エンドポイントは [`../interface/sidecar-http-api.md`](../interface/sidecar-http-api.md)。
