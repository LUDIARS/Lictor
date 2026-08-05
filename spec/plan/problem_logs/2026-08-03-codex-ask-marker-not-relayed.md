# Codex askマーカーが質問カードへ変換されず消える

- Date: 2026-08-03
- Status: fixed in working tree
- Area: Codex transcript relay / ask-marker / Concordia egress
- Severity: high — ユーザ判断を求める質問がDiscordへ届かず、セッションが停止する

## Summary

LictorでラップされたCodexセッションが、規定どおり `ask` フェンスとJSONで質問を
2回出力したが、Discord側に質問カードも本文も表示されなかった。
これは質問リレー機能の回帰であり、モデルがユーザ判断待ちになったまま遠隔利用者が
回答できない。

## Evidence

- 2026-08-03 13:25 JSTに開始した対象sidecarは `concordia_enabled: true`、
  Discord session channelも `active` だった。
- 2026-08-03 14:06 JST前後、同一セッションで正常な `ask` JSONを2回出力したが、
  ユーザから「Question(AskUserQuestion)が届いてない」「再度送信してもダメ」と報告された。
- 稼働プロセスは `.wt-Lictor-runtime-repair/bin/lictor.mjs`、Lictor versionは `0.7.0`。
- sidecarの `GET /v1/skill` は `503 skill injector not initialized` を返した。
- `src/provider.ts` のCodex設定は `skillStrategy: "none"`、`supportsSkills: false`。
- `src/wrap.ts` は `provider.supportsSkills` がfalseの場合 `injector = null` とする一方、
  `askMarkerActive` の有効化全体を `if (concordia && injector)` の内側に置いている。
- `src/transcript-tail.ts` は `opts.askMarkerEnabled` がtrueの場合だけ `ask` を
  `postPendingQuestion()` へ渡すため、今回のCodexセッションでは質問カード登録が走らない。
- Concordia `src/platform/egress-filters.ts` は通常のtranscript本文から `ask` ブロックを
  無条件に除去する。askだけの本文は空になり、`src/platform/transcript-relay.ts` で破棄される。

## Regression Context

`ask-marker` の共通skill、Codex transcript正規化、pending-question投稿、Concordia側の
raw JSON除去は個別には実装されている。しかし、Codexのsession skill injectionを無効にした
変更と、マーカー検出の有効化条件が結合したことで、質問カード化されないのにraw本文だけが
除去される状態になった。既存のparser単体テストでは、このprovider構成を通した統合条件を
検出できない。

## Cause

直接原因は、`askMarkerActive` が「マーカー検出を有効にできるか」ではなく、
「session-scoped `SkillInjector` が存在するか」に依存していること。

Codexは共有skill汚染を避けるため意図的に `supportsSkills=false` であり、injectorを作らない。
それでもグローバルの `lictor-ask-marker` skillは利用可能で、transcript parserもprovider非依存で
動作できる。しかし `concordia && injector` の条件によりparserまで無効化される。

その後、Concordiaが「Lictorで構造化済み」という前提でraw `ask` を除去するため、
ユーザから見ると質問が無言で消える。

## Fix Requirements

1. Codexのaskマーカー検出を `SkillInjector` の有無から切り離す。
2. Concordia連携中のCodexでは、session-scoped skill injectionが無くても
   `askMarkerEnabled` を有効にできる明示的なprovider capabilityを持たせる。
3. pending-question投稿失敗または検出無効時に、質問本文が無言で消えないfail-loud経路を設ける。
4. 起動時ログにprovider、ask-marker enabled/disabled、無効理由を記録する。
5. LictorとConcordiaのどちらがrawマーカー除去の責務を持つかを契約として一元化する。

## Verification

`src/ask-marker-activation.ts` に検出可否と注入方式の純粋な判定を分離し、Codex +
Concordia有効ではinjectorなしでも検出が有効になる回帰テストを追加した。`src/wrap.ts` は
判定理由を起動時に必ずログ出力し、Claudeのprompt書き込み失敗時は無効状態を明示する。
pending-question登録失敗時は質問部分だけをraw askとして通常中継へ戻すfail-loud経路も追加した。

ユーザ指示によりテストは実行していない。次を追加・確認対象として残す。

- Codex (`supportsSkills=false`, injectorなし) + Concordia有効で検出が有効になる単体回帰テスト
  （追加済み、未実行）。assistantの正常な `ask` がpending-question APIへ1回投稿される統合確認。
- askだけの出力でDiscord質問カードが作成され、通常本文が空でも質問が見える回帰テスト。
- pending-question APIが失敗した場合、raw質問または明示的なエラー通知が残るテスト。
- Claude / Codex双方で二重カードやraw JSON二重表示が起きないことの回帰テスト。

## Follow-up

- 修正はLictorとConcordiaの境界をまたぐため、両リポジトリの契約を確認して実装する。
- 修正版Lictorをbuild・配備した後、既存セッションには再起動が必要。
- 修正反映まではCodexセッションで `ask` マーカーだけに依存せず、通常本文でも判断依頼を伝える。

## Revisor review follow-up

登録済みtest/typecheckは全件通過した。初回レビューでは自動生成された`ask-marker-relay`
ドメインにmembershipが無く、生成された`@implements ASK-*`もAnatomiaが認識する`SPEC-*`
形式ではなかったため、対象ドメインとspec linkageが不十分と判定された。

また、`runWrapped`から既存の`newNotifyState` / `newTaskState` / `pollLiveState`を呼ぶ辺が、
プロジェクト規則ではない組み込み例`transition-guard-example`に誤検出された。Lictorがこの
state-machine規則を採用しないことをtaxonomyへ明記し、同名の追跡済みpolicy overrideで
組み込み例を無効化した。ask-marker関連pathのmembershipと`SPEC-*`明示リンクも追加している。
