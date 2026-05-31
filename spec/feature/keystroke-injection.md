# キーストローク注入

## 目的
hook やリモート（Concordia）から、ラップ中 CLI の TUI に **キー入力を代行**して
slash command / 回答 / リネーム等を行う。**第 2 の trust boundary**。

## 振る舞い（sidecar 経由、[`../interface/sidecar-http-api.md`](../interface/sidecar-http-api.md)）
- `POST /v1/rename {text}` — `/rename <text>\r` を注入（実セッション非ラップ時 503）。
- `POST /v1/slash {cmd, args?}` — 汎用 `/<cmd> <args>\r`。`cmd` は `^[a-z][a-z0-9-]{0,40}$`。
- `POST /v1/keys {data}` — 生キー。C0 制御は `\t \n \r \b ESC` 以外除去、Ctrl-C は
  誤セッション kill 防止のためドロップ。
- `POST /v1/answer {choice, escape_first?}` — `AskUserQuestion` picker 回答。
  `choice` は 1-based（1–50）、Down×(choice-1) + Enter を送る
  ([`../../src/ask-question-relay.ts`](../../src/ask-question-relay.ts))。

## Trust boundary（必須サニタイズ）
`ctx.ptyWriter(rawUserInput)` を直接呼んではいけない。注入前に必ず
`sanitizeRenameArg` パターンでサニタイズする:
1. C0 / DEL を除去、2. 先頭 `/` を除去（slash command チェイン防止）、
3. 長さ cap、4. trim。テストは `rename.test.ts` / `slash-keys.test.ts` /
`ask-question-relay.test.ts` で固定。
