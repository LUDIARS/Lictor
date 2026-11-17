---
task: session-dir-trust
project: Lictor
kind: 実装
status: review
created: 2026-11-17
source_session: lictor-f33fb602-3506-47bc-bd88-04db9d7833aa
memoria_task_id: null
actio_task_id: 9de37a35-d114-4da1-bbeb-ceb6690e2961
memory_links: []
---

# セッション用フォルダ (--add-dir) の trust picker を起動前の登録で出さなくする

## 目的

Lictor が claude へ `--add-dir` で渡すセッション用フォルダ (`~/.claude/lictor/sessions/<sessionId>`)
について、claude が起動のたびに trust picker を出す問題をなくす。起動フォルダ (cwd) の扱いは
変えない。仕様は `spec/feature/session-dir-trust.md` (SPEC-SESSION-DIR-TRUST) に書いた。

## 調べた事実

- claude 2.1.326 は追加フォルダごとに、`projects[<キー>].hasTrustDialogAccepted === true` を
  完全一致で調べる。親フォルダへは辿らない。キーは解決済みの絶対パスを `/` 区切りにしたもの。
- 手元の `~/.claude.json` には sessions 配下の登録が 1 件も無い。セッション用フォルダは毎回
  新しいので、毎回 picker が出る。

## 変更内容

- `src/session-dir-trust.ts` (新規): 起動前の登録、終了時の登録解除、sessions 直下で実フォルダが
  消えた登録の掃除。sessions 直下 1 階層だけを対象とし、それ以外の登録には触れない。
- `src/session-dir-key.ts` (新規): キー判定の純粋関数 (contract 述語と共用するため、循環 import を避けて分けた)。
- `src/claude-json.ts` (新規): `~/.claude.json` の読み書き・パス解決・キー比較を共通化した。
  `workspace-trust-seed.ts` もこれを使う (cwd の登録の動作と判定条件は同じまま)。
- `src/skill-injector.ts`: `sessionsRoot` を公開した。
- `src/wrap.ts`: Claude かつ `claude-add-dir` の起動では、Concordia の有無を問わず spawn 前に登録する。
  終了処理ではフォルダの片付け後に登録を外す。失敗時のログは固定の 1 行だけで、パスを出さない。
- 契約 C-6 / C-7 (`augur.contracts.json`, `src/contracts/session-dir-*.contract.ts`)、domain 定義の更新。

## 再利用探索の採否

- 採用: `workspace-trust-seed.ts` の安全策 (無い・壊れている・形が想定外なら書かない) と
  キー正規化。重複して書かずに `claude-json.ts` へ移して共用した。
- 不採用: `seedWorkspaceTrust` をそのまま流用する案。上位の `.mcp.json` を無効化する処理と、
  Cc 起動に限る判定が付いているため、セッション用フォルダには合わない。
- 不採用: claude の `workspace-trust` サブコマンド。手元の版では読み取り専用の確認しかできない。

## 完了条件

- [x] Lictor の sessions 直下のフォルダだけを起動前に trust 済みとして登録する (人間の端末起動も含む)。
- [x] cwd の扱いと既存の判定は変えない。
- [x] 終了時に登録を外し、実フォルダが無い登録を掃除して、登録が増え続けないようにする。sessions 外の登録は壊さない。
- [x] 壊れた `~/.claude.json` には書かない。ログにパスや個人情報を出さない。
- [x] 一時フォルダの設定ファイルで回帰テストを書く (本物の `~/.claude.json` には触れない)。

## 検証

- `tsc --noEmit`: エラー無し。
- `node --test --import tsx tests/session-dir-trust.test.ts tests/workspace-trust-seed.test.ts`: 17 件すべて通過。
- Augur の集計で C-6 (15 回呼び出し) と C-7 (4 回呼び出し) は違反 0。
- 未実施: `npm test` 全体と、実際の claude 起動で picker が出ないことの確認 (起動テストは委託範囲外)。
  マージ後は Lictor 本体フォルダで `npm run build` が必要で、次の起動から効く。
