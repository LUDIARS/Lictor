# Detached workspace trust seeding

## SPEC-WORKSPACE-TRUST-SEED

Concordia enrollment 付きで登録された Cc 起動の Claude spawn は、Claude 起動前にその
`cwd` の workspace trust を `~/.claude.json` へ登録し、初回 picker の入力タイミングに依存せず
起動できる。Cc が Windows Terminal tab へ起動した session は stdin が TTY でも picker に
応答する人間がいないため、TTY 状態は eligibility に使わない。

この永続変更は次の条件をすべて満たす場合に限る。

- Concordia session 登録が成功している。
- 有効な spawn metadata から `CONCORDIA_SPAWN_ID` enrollment が確立している。
- provider が Claude である。

同じ探索範囲の `.mcp.json` にある server のうち、既存 entry で人間が enable 済みのものは
維持する。未判断の server は command 実行を暗黙に許可せず disabled として登録し、MCP picker
を抑止する。壊れた JSON や期待する object / array 形状でない Claude 設定は上書きしない。
診断ログには workspace の絶対パス、MCP server 名、ファイル I/O 例外の詳細を含めない。

## テスト

`tests/workspace-trust-seed.test.ts` は TTY 状態に依存しない eligibility の全条件、既存設定の
保持、壊れた設定の非破壊、冪等性、上位 `.mcp.json` の探索を固定する。Claude 本体が
対象バージョンで設定を認識し、TTY 付き Cc spawn で picker を省略することは実動確認で
検証する。
