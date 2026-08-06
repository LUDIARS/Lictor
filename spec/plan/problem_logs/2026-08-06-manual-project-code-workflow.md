# Manual Project Code and Review Workflow

- Date: 2026-08-06
- Status: fixed in working tree
- Area: CLI session coordination
- Severity: repeated operational waste

## Summary

実装作業のたびに project code 表、session id、Cc/Ex/Rv endpoint を探し、複数コマンドを
手で連結していた。決定的な操作を session 判断へ残した回帰である。

## Evidence

- `lictor cli task set` は project code を含む description を呼び出し側へ要求した。
- testing claim、Excubitor control、release は別操作だった。
- local PR は session id を取得して `POST /v1/prs/local` へ渡す必要があった。

## Regression Context

Cc には各APIとproject resolverが既にあったが、Lictorに一続きの実装workflow操作面がなかった。

## Cause

skill文書が手順を説明するだけで、ツールが状態と遷移を所有していなかった。

## Fix Requirements

- 実装作業だけが明示opt-inする。
- 既存Cc/Ex/Rv状態を正本にし、Lictorを高速な操作窓口にする。
- project code/session id/endpointを自動解決する。
- service操作とreview提出・再提出を単一コマンドにする。

## Verification

Revisorがbuild/typecheck/unit/API contractを実行する。session自身はユーザー指示がないため
テストを実行しない。

## Follow-up

配布後、手動curl中心のskill記述をCLI呼び出しへ同期する。
