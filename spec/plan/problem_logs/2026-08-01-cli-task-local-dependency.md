# Cc 登録用 CLI がローカル依存欠落で全セッション失敗する

- 発生日: 2026-08-01
- 状態: fixed-in-branch
- 対象: Lictor `cli task get/set`

## 現象

各 Lictor-wrapped session で Cc 作業登録を行うと、CLI の処理開始前に次の例外で終了する。

```text
Cannot find module 'E:\\Document\\Ars\\Lictor\\node_modules\\@ludiars\\vestigium\\dist\\index.js'
```

## 原因

`src/cli.ts` が全コマンド共通の top-level で `@ludiars/vestigium` を static import していた。
この依存は `file:./lib/vestigium` の submodule package で、`dist` は git 管理外である。
checkout/submodule 更新後などに nested build artifact が無いと、Vestigium を使わない
`lictor cli task set` まで module load 時点で停止した。

## 修正

- Vestigium を long-running provider / local-agent 起動時だけ動的に読み込む。
- 読み込み失敗時は観測ログだけを縮退し、session control 自体は継続する。
- `LICTOR_DEBUG=1` の場合だけ縮退理由を stderr へ出す。hook/通常 CLI を汚さない。
- 縮退ロジックは entrypoint (`src/cli.ts`) から `src/vestigium.ts` に切り出した。
  `installVestigiumBestEffort(load?)` の `load` 差し替えで単体テスト可能。
- 仕様は `spec/setup/setup.md` §観測 (Vestigium) は best-effort に記載。

## 検証方針

`tests/vestigium-optional.test.ts` が縮退挙動 (module 読込失敗 / install 例外 /
`LICTOR_DEBUG` による stderr 出力有無) を固定する。
ユーザの Cc 作業ポリシーに従い、この branch では test/build/startup を実行しない。
Revisor TestWorkflow と、反映後に Vestigium dist を一時的に欠く状態での
`lictor cli task get/set` を確認する。
