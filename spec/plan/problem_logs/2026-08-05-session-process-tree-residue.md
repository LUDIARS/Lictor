# Lictor終了後にCodex補助プロセスが残留する

- Date: 2026-08-05
- Status: fix implemented; Revisor verification pending
- Area: session process lifecycle / Windows ConPTY
- Severity: 長時間運用でPC全体の応答性が低下する

## Summary

セッションを長時間・並行運用すると、終了済みセッション由来とみられるCodex CLI、Node REPL、
Code Mode host、command runnerが残留する回帰が確認された。単一processの短時間リークではなく、
session単位のprocess treeが正常終了時に完全回収されないことで資源が累積する。

## Evidence

- 2026-08-05 20時台の実測でCodex関連は約63 process、約3.5 GB working set、約13,900
  handles、約1,520 threadsを保持していた。
- 24時間以上生存しているCLI 7件、Code Mode host 7件、Node REPL 8件を確認した。
- 12秒観測ではhandlesは増加せず、1,522 threads中1,521がwait状態だったため、実行中process
  内部の即時リークより終了済みsessionの残留が主要因と判断した。
- `src/wrap.ts` のWindows終了は `node-pty` の `child.kill()` のみで、process treeを明示的に
  回収していない。
- Concordia `spec/feature/session-process-reaper.md` も、Windows/ConPTYではlauncherだけが
  終了して子孫が残り得ることを既知原因として記録している。

## Regression Context

`POST /v1/shutdown` は2026-08-05に実装されたが、契約上の「wrapped CLI終了」がWindowsの
process tree全体ではなくPTY直下の終了に留まっていた。既存reaperは異常終了の保険であり、
正常なsession-end時の所有者による解放を代替しない。

## Cause

Lictorはsession固有resourceの所有者だが、Windowsの終了実装がPOSIX signal相当のdirect killに
依存していた。またshutdown経路はprocess終了後にLictor内のtimer、sidecar、session skill
directoryを明示cleanupせず、`process.exit()`へ進んでいた。

## Fix Requirements

- Windowsの明示shutdownでPTY child PIDをrootにprocess tree全体を非同期終了する。
- tree killを待ってからtranscript flushとarchiveへ進む。
- tree kill失敗時はdirect killを試し、失敗を隠さずConcordia reaperへ回収を委ねられるようにする。
- HTTP応答後・Lictor終了前にsession固有のtimer、listener、sidecar、注入directoryをcleanupする。
- Excubitor所有の常駐serviceをsession終了へ巻き込まない。

## Verification

- taskkillのcommand/arguments、成功時、失敗時fallback、非Windows経路をunit testで固定する。
- shutdown順序が unregister → tree kill → flush → archive → response → cleanup → exit であることを
  unit testで固定する。
- Revisorのtest実行後、project本体からExcubitor経由の起動テストを別途行う。

## Follow-up

Concordia reaperはLictor crash、shutdown不達、既に親PIDが消えた孤児を扱う外部保険として維持する。
