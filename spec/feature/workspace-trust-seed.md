# Detached workspace trust seeding

## SPEC-WORKSPACE-TRUST-SEED

Concordia enrollment 付きで登録された非対話 Claude spawn は、Claude 起動前にその `cwd` の workspace
trust を `~/.claude.json` へ登録し、初回 picker の入力タイミングに依存せず起動できる。

この永続変更は次の条件をすべて満たす場合に限る。

- Concordia session 登録が成功している。
- 有効な spawn metadata から `CONCORDIA_SPAWN_ID` enrollment が確立している。
- stdin が TTY ではない。
- provider が Claude である。

同じ探索範囲の `.mcp.json` にある server のうち、既存 entry で人間が enable 済みのものは
維持する。未判断の server は command 実行を暗黙に許可せず disabled として登録し、MCP picker
を抑止する。壊れた JSON や期待する object / array 形状でない Claude 設定は上書きしない。
診断ログには workspace の絶対パス、MCP server 名、ファイル I/O 例外の詳細を含めない。

## テスト

`tests/workspace-trust-seed.test.ts` は eligibility の全条件、既存設定の保持、壊れた設定の
非破壊、冪等性、上位 `.mcp.json` の探索を固定する。Claude 本体が対象バージョンで設定を
認識して picker を省略することは detached spawn の実動確認で検証する。
