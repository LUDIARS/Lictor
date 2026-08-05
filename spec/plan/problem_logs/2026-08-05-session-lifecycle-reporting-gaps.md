# active repo・session shutdown・完了お伺いの欠落

- Date: 2026-08-05
- Status: fixed in working tree
- Area: Concordia integration / session lifecycle
- Severity: session 表示の誤同定、終了済みprocess残留、完了後判断の欠落

## Summary

Lictor の active repo relay は一覧だけが増えた場合にCcへ通知せず、worktree pathを本体repoへ
正準化していなかった。また session-end 後にwrapped CLI、ログarchive、Lictor自身を順序付きで
終了する入口と、Ccのcompletion判定からお伺いを送る経路が無かった。

## Evidence

- `src/wrap.ts` のrelay条件が `activeChanged` のみに依存していた。
- session-end skillとslash commandは独白後のshutdown手順を持っていなかった。
- sidecar APIに `POST /v1/shutdown` が存在しなかった。
- Ccは `taskflow.completion_detected` を通知するがLictor側にconsumerが無かった。

## Regression Context

active repo一覧と直近repo pathを別状態として持つ設計に対し、更新条件が片方だけを見ていた。
shutdownとinquiryは2026-08-02確定仕様に対する未実装である。

## Cause

checkout pathと正準repo rootの責務、session終了の順序制御、完了通知の転送責務が独立moduleとして
定義されていなかった。

## Fix Requirements

- git common dirから正準rootを解決し、cache・fallback・順序維持を行う。
- unregister → kill/flush → archive → exitを独立moduleで保証する。
- Cc completion通知にだけ反応し、固定category `タスク` で機械的contextを送る。

## Verification

通常checkout/worktree形状、cache/fallback、shutdown順序と冪等性、archive copy/truncate、
completion eventのsession照合、inquiry payloadのunit testを追加する。ユーザー方針によりこの
sessionではtestを実行しない。

## Follow-up

Revisorの登録testとreviewを通し、サービス反映後はproject本体からExcubitor経由でshutdownの
動作確認を行う。
