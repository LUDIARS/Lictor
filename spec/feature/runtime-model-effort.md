# Runtime Model and Effort Switching

## SPEC-RUNTIME-MODEL-EFFORT

`POST /v1/runtime/model-effort` は、loopback sidecar がラップしている provider の
実行時設定を切り替えるための API である。

### Contract

- Request body の `model` と `effort` は文字列でなければならない。
- `model` は `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` に一致するものだけを受け入れる。
- Claude の `effort` は `low`、`medium`、`high`、`xhigh`、`max` のいずれかだけを
  受け入れる。
- Claude は `/model <model>\r` の完了待機後に `/effort <effort>\r` を送る。同じ
  PTY への複数 request は、model/effort の対が混在しないよう直列化する。
- Codex の `/model` は catalog-order-dependent picker のため、キー操作を推測せず
  `409 interactive_selection_required` を返す。
- PTY が無いときは `503 pty_not_available`、対応しない provider は
  `409 provider_runtime_switch_unsupported` を返す。

### Metadata

Wrapped-provider arguments から明示された model と effort を抽出する。Claude は
`--model` と `--effort` を、Codex は `--model` と
`--config model_reasoning_effort=<value>`（または `-c`）を扱う。`--` 以降は
provider runtime metadata として解釈しない。

### Responsibility boundary

この機能は既存の `session-coordination` ドメインに属する。Lictorは、現在ラップしている
sessionへのprovider固有コマンド適用、入力検証、直列化、runtime metadata報告だけを担う。
Geniusの照会、model/effort候補の選定、ユーザ確認UI、変更を適用するかの判断はCcの責務であり、
Lictorへ持ち込まない。LictorはCcから確定済みの値を受け取る実行境界である。
