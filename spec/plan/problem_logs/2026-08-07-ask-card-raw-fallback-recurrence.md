# Ask カードが raw フォールバックとして再表示される

- Date: 2026-08-07
- Status: investigating
- Area: Codex ask-marker relay / Lictor runtime freshness
- Severity: high — リモート利用者が質問カードで回答できない

## Summary

2026-08-07 にユーザーから、Discord 上で「質問カードを生成できませんでした」と
` ```ask ` ブロックが併記され続ける再発報告があった。これは質問カードとして
登録されるべき ask マーカーが、生テキストとして Concordia へ到達したことを示す。

## Evidence

- ユーザーが確認した表示には `質問カードを生成できませんでした` と raw `ask` ブロックが含まれる。
- `src/ask-marker-activation.ts` は、Concordia 連携中の Codex で session-scoped
  `SkillInjector` の有無にかかわらず ask マーカー検出を有効化している。
- この checkout には git 管理外の root `dist` が存在しないため、実行ホスト上の
  `dist/wrap.js` の内容と source との新旧はこの調査だけでは確認できない。
- `bin/lictor.mjs` は新規起動時に source より古い、または欠落した root `dist` を検知して
  再ビルドする。

## Regression Context

同じ原因は [2026-08-03-codex-ask-marker-not-relayed.md](2026-08-03-codex-ask-marker-not-relayed.md)
に記録済み。2026-08-06 には stale `dist` による再発も記録された。

## Cause

現時点の source には既知修正が含まれる。実行ホスト上の root `dist` の鮮度と実行元は未確認の
ため、第一候補は修正前に起動した Lictor プロセス、または古い `dist` を実行したプロセスが
旧コードを継続使用していることである。実行中セッションの再起動前に、起動ログで
`ask-marker provider=codex enabled=true` と実行元を確認する必要がある。

## Fix Requirements

1. Codex + Concordia セッションでは、session injector の有無に関係なく ask マーカーを解析する。
2. 正しい ask JSON は raw relay ではなく pending-question API に一度だけ登録する。
3. 新規起動時は source より古い、または欠落した root `dist` を実行しない。
4. 実行中セッションの再起動が必要なら、利用者の明示承認と Concordia の事前通知を得る。

## Verification

この作業ではユーザー方針に従いテストおよびサービス起動・再起動は実行していない。
回帰テストは Codex + Concordia + injector なしで activation が有効になること、および valid
ask JSON が pending-question API に一度だけ送られることを確認する。

## Follow-up

再発時は対象セッションの起動時ログと実行元を確認する。停止中の Lictor を再起動する場合は
Cc の testing claim/release 手順を適用する。
