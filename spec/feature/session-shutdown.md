# session shutdown

`POST /v1/shutdown` は session-end の終局処理を次の順で所有する。

1. Concordia unregister（失敗しても続行）
2. wrapped CLI の即時終了と transcript sink の最大5秒 flush
3. transcript、session state、metadata の archive
4. HTTP 応答後の Lictor process 終了予約

二重要求は `{ ok: true, already: true }` で no-op とする。CLI が既に終了している
場合は kill を省略し、archive 失敗時は `archived: null` と警告を返して終了を続ける。

archive は `<workspace-root>/session-logs/archive/<date>/<session-id>/` に置き、元ファイルを
コピーする。gzip 結果が100MBを超える transcript は元データの先頭・末尾50MBを残して
再圧縮し、`meta.json` の `truncated` を `true` にする。

設計正本は Concordia `spec/feature/session-shutdown.md`。
