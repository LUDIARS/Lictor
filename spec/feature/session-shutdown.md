# session shutdown

`POST /v1/shutdown` は session-end の終局処理を次の順で所有する。

1. Concordia unregister（失敗しても続行）
2. wrapped CLI の process tree を即時終了
   - Windows は node-pty の direct kill だけに依存せず `taskkill /F /T /PID <pty pid>` を待つ。
   - `taskkill` 失敗時は direct kill へ縮退し、失敗を warning として観測可能にする。
   - POSIX は既存の node-pty signal 経路を維持する。
3. transcript sink の最大5秒 flush
4. transcript、session state、metadata の archive
5. Concordia へ session-end 完了通知 (`POST /v1/sessions/:id/session-end-done`、失敗しても続行)
6. HTTP 応答後に timer、listener、sidecar、session skill directory、terminal raw mode 等を cleanup
7. Lictor process 終了予約

二重要求は `{ ok: true, already: true }` で no-op とする。CLI が既に終了している
場合は kill を省略し、archive 失敗時は `archived: null` と警告を返して終了を続ける。

process tree の所有範囲は Lictor が起動した wrapped CLI とその子孫に限る。Excubitor が
所有する常駐serviceはsession treeへ含めず、Concordiaのprocess reaperはLictor crashや
shutdown不達時の外部保険として維持する。

## SPEC-SESSION-END-DONE: 完了通知はコードが出す

session-end 完了通知は shutdown の一段として Lictor が送る。skill の手順や運用者の
手作業に依存させない。

- 送出は kill / flush / archive の**後**。この通知は Concordia に対する
  「記録済み PID を止めてよい」の合図なので、実体が止まる前に出してはいけない。
- cleanup の**前**。HTTP listener を閉じた後では届かない。
- 失敗は握り潰さず warning として観測できるようにし、shutdown の残りは続行する
  (Concordia 側に時間ベースの保険回収があるため、通知失敗は致命ではない)。

この通知が skill markdown の `curl ... || true` にしか存在しなかった間、自動
session-end では一度も送られず、Concordia 側の `session_end_pending_at` が永久に
残って回収経路が塞がっていた
(`Concordia/spec/plan/problem_logs/2026-08-08-ended-session-process-residue.md`)。

## SPEC-SESSION-PROCESS-TREE: wrapped CLI tree termination

- Windows の wrapped CLI 終了は、有効な PTY child PID だけを root に
  `taskkill /F /T /PID <pid>` で非同期に完了を待つ。shell は使わない。
- `taskkill` が失敗または timeout した場合は node-pty の direct kill を試し、元の
  失敗は warning として残す。両方失敗した場合も shutdown の残りの段階は継続する。
- Windows 以外では既存の node-pty signal 経路を使う。

archive は `<workspace-root>/session-logs/archive/<date>/<session-id>/` に置き、元ファイルを
コピーする。gzip 結果が100MBを超える transcript は元データの先頭・末尾50MBを残して
再圧縮し、`meta.json` の `truncated` を `true` にする。

設計正本は Concordia `spec/feature/session-shutdown.md`。
