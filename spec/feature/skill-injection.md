# skill 注入

## 目的
ラップ中の Claude Code セッションに **per-session SKILL.md** を動的注入し、
セッション文脈（persona / 現在タスク / 競合 / repo 関連メモリ等）を skill として
供給する。

## 振る舞い（[`../../src/skill-injector.ts`](../../src/skill-injector.ts)）
- セッション専用ディレクトリを `--add-dir` で claude に渡す
  （`~/.claude/skills/<id>/` ではなく add-dir 方式。理由は
  [`../../DESIGN.md`](../../DESIGN.md) §Why --add-dir）。
- `writeSkill` / `deleteSkill` のみを通す（name 正規表現 + 32 KiB body cap を強制。
  `writeFileSync` 直書き禁止）。
- 起動時シード: persona / session-context / task-protocol などを書き出す。
- mid-session 更新: `POST /v1/skill {name, content}` で上書 → claude が live-reload。
  watcher の取りこぼし対策あり（[`../../DESIGN.md`](../../DESIGN.md) §watcher gotcha）。
- `GET /v1/skill` で注入済一覧、`DELETE /v1/skill/<name>` で削除。

## repo 関連メモリ供給
[`../../src/memory-loader.ts`](../../src/memory-loader.ts) は純関数で、
`(memoryDir, repoLeaf)` から関連メモリをスコア付きで返す。`repoLeafFromCwd` は
OS 非依存（`/` `\` 両対応）。スコアリング変更時は `memory-loader.test.ts` を更新。

## Trust boundary
注入名は正規表現で制限、本文は 32 KiB cap。`skillsDir` への直書き禁止。
