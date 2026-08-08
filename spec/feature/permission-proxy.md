# 許可プロキシ（PreToolUse）

> Spec ID: `SPEC-PERMISSION-PROXY`

## 目的
Claude Code の **PreToolUse 許可判断** を Concordia / Web UI 側へ橋渡しし、
セッション横断での許可制御（auto-mode の許可範囲抑制等）を可能にする。

## 振る舞い（[`../../src/permission-hook.ts`](../../src/permission-hook.ts)）
- PreToolUse hook のブリッジとして動作し、session-scoped な settings 注入で
  許可/保留を返す。
- Concordia Web UI 側で「保留 → 後から判断」する deferred decision に対応。
- Legacy auto-like modes are classified only for deferring notifications about
  harmless tools; dangerous tools stay on the human-confirmation path.
- Claude Code の現在の `permission_mode: "auto"` は Claude 自身の許可ポリシーを
  優先する。Lictor はこの値（前後空白・大文字小文字を無視）では**決定 JSON を出力せず**、
  sidecar / Concordia への問い合わせもしない。他の mode は従来どおり coordinator
  backed の許可フローに渡す。

## テスト
`tests/permission-proxy.test.ts`（PreToolUse 許可中継の経路）と
`tests/permission-mode.test.ts`（Claude native `auto` の proxy 回避）。
