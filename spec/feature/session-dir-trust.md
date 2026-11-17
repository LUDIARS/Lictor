# セッション用フォルダの workspace trust

関連タスク: `actio:9de37a35-d114-4da1-bbeb-ceb6690e2961`

## SPEC-SESSION-DIR-TRUST

Lictor は claude へ `--add-dir <sessionDir>` (`~/.claude/lictor/sessions/<sessionId>`) を渡す。
claude 2.1.x (2.1.326 で確認) は追加フォルダごとに `~/.claude.json` の
`projects[<キー>].hasTrustDialogAccepted === true` を完全一致で調べ、親フォルダへは辿らない。
キーは解決済みの絶対パスを `/` 区切りにしたもの (フォルダが git 管理下ならその git ルート)。
セッション用フォルダは起動のたびに新しく作られるので、登録が無いと毎回 trust picker が出る。

### 登録 (起動前)

- provider が Claude で、skill 戦略が `claude-add-dir` の起動では、claude を spawn する前に
  セッション用フォルダを trust 済みとして登録する。Concordia 登録の有無や、人間が端末から
  起動したかどうかは問わない。中身は Lictor が書いた skill と hook 設定だけだからである。
- 登録してよいのは `sessionsRoot` (`~/.claude/lictor/sessions`) の直下 1 階層のフォルダだけで、
  それ以外のパスは何もしない。
- cwd の trust と、その判定条件 (`SPEC-WORKSPACE-TRUST-SEED`) は変えない。起動フォルダ (cwd) は
  呼び出し元の指定のまま (Ars ルートなど)。

### 増え続けないようにする

- 終了処理でセッション用フォルダを消した後、自分の登録を `~/.claude.json` から外す。
- 起動時と終了時に、`sessionsRoot` 直下の登録のうち実フォルダがもう無いものを消す。
  これで異常終了や、終了後に claude が設定を書き戻した分も次の起動で回収される。
  実行中の別セッションのフォルダは残っているので、その登録は消さない。
- `sessionsRoot` の外にある登録 (人間が trust した既存のプロジェクト) は変えない。

### 安全策

- `~/.claude.json` が無い・壊れている・`projects` や自分の entry が想定する object の形でない
  場合は書かない (`claude-json.ts` の `loadClaudeJson` を cwd の登録と共用する)。
- 変更が無ければ書かない。
- `CLAUDE_CONFIG_DIR` があれば、その下の `.claude.json` を使う。
- 診断ログには、パス・セッション id・ファイル I/O 例外の詳細を出さない。失敗したときに
  固定の 1 行を出すだけにする。

## テスト

`tests/session-dir-trust.test.ts` は、次の動作を一時フォルダの設定ファイルで固定する。

- sessions 直下だけを登録すること (それ以外は null)
- 実フォルダが無い登録の掃除と、実行中のフォルダ・sessions 外の登録を残すこと
- 終了時に登録を外すこと
- 壊れた設定に書かないこと
- 冪等であること
- Windows の表記ゆれ (区切り文字と大小文字) を同じキーとして扱うこと

本物の `~/.claude.json` には触れない。claude 本体が picker を出さなくなることは、実際の起動で確かめる。
