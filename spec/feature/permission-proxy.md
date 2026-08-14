# 許可プロキシ（PreToolUse + Notification）

> Spec ID: `SPEC-PERMISSION-PROXY`

## 目的
Claude Code が **実際に人間の許可を待って停止したとき** だけ、 Concordia / Discord /
Web UI に許可 UI を出し、 リモートから回答できるようにする。 併せて、 人間に聞かれずに
通ったコマンドを監査ログに残し、 `settings.json` の漏れを可視化する。

## なぜ発火点を変えたか

PreToolUse hook は **ツールを呼ぶたび** に発火する。 Claude が「これは許可が要るか」 を
判定する前なので、 ここでカードを出すと全コマンドで出る。 実際そのため
`conn_permission_requests_enabled` は false で封じられていた。 auto mode の許可判断は
Claude 自身が動的に行うもので `settings.json` の規則から静的には予測できず、
非 auto mode でも「規則で自動許可されるか」 は hook の時点では判らない
(mode で分岐して非 auto だけ掴む折衷案も 2026-08-14 に破れた)。 だから
**PreToolUse では mode を問わず一切判断しない**。

Notification hook は **Claude が人間の入力待ちで止まったとき** にしか発火しない。
これが「設定・モードに関わらず、 本当に許可が要るもの」 の唯一の確かな合図になる。

## 経路

1. **PreToolUse** — [`../../src/permission-hook.ts`](../../src/permission-hook.ts) が
   全ツール呼び出しを sidecar へ渡す。 **mode を問わず decision は返さない**ので
   Claude 自身の許可エンジンがそのまま決める (追加レイテンシは loopback 往復のみ)。
   観測は [`../../src/permission-pending.ts`](../../src/permission-pending.ts) の
   リングバッファへ積むだけ。

   > mode で分岐して hook を掴んでいた頃は、 非 auto セッション (default /
   > acceptEdits) で `settings.json` が自動許可するはずのコマンドにもカードが出た
   > (2026-08-14 に実害)。 PreToolUse は Claude の許可判定より前に走るので、
   > 「聞かれるかどうか」 はここでは原理的に判らない。
2. **Notification** — [`../../src/notification-hook.ts`](../../src/notification-hook.ts) が
   message を sidecar へ渡す。
   [`../../src/permission-notify.ts`](../../src/permission-notify.ts) が許可待ちかどうかを
   判定し、 許可待ちのときだけ直前の観測と突き合わせて Concordia へ投稿する。
   - `waiting for your input` 系 (60s 無操作の催促) では投稿しない。
   - 突き合わせに失敗しても投稿する。 コマンド名より「止まっている」 事実が重要。
   - どのパターンにも当たらない message は監査ログに `notification-unknown` で残す
     (文言変更を沈黙で握りつぶさない)。
3. **回答** — Discord / Web UI の回答は
   `/v1/internal/permission-response` に返る。 Notification 起点の要求は hook を掴んで
   いないので、 [`../../src/permission-answer.ts`](../../src/permission-answer.ts) の
   固定シーケンスを TUI へ打鍵する。
   - `allow` → Enter (既定選択のまま。 選択肢構成が変わっても誤爆しない)
   - `deny` → ESC
   - `ask` → 打鍵しない (人間が TUI で決める)
   - Notification 起点の回答受付はカード投稿から 10 分で失効する。既にローカルで
     処理されたダイアログや通常の TUI へ、遅延した回答を注入しないためである。
4. sidecar `close()` で待ち行列を捨てる (停止後に pty へ打鍵しない)。

実体は [`../../src/permission-runtime.ts`](../../src/permission-runtime.ts) に集約し、
`sidecar.ts` は HTTP の入口だけを持つ。

## 監査ログ

[`../../src/permission-audit.ts`](../../src/permission-audit.ts) がイベントごとの
JSONL を `<state-dir>/permission-audit-<YYYY-MM-DD>.jsonl` へ追記する
(セッション横断・日付ごと・best-effort)。PreToolUse 時点の `auto-allowed` は候補であり、
同じ `request_id` に後続の Notification イベントがあれば、集計時に自動許可から除外する。

| 項目 | 内容 |
|---|---|
| `outcome` | `auto-allowed` / `prompted` / `answered-remote` / `notification-unmatched` / `notification-unknown` / `post-failed` |
| `rule` | 当たった settings 規則 `{effect, rule, source}`。 `null` = **どの規則にも載っていない** |
| `evasion` | prefix 規則を素通りしうる形の印 (`shell-wrapper` / `chained` / `substitution` / `eval` / `env-prefix` / `path-qualified`) |

`rule` の判定 ([`../../src/permission-rules.ts`](../../src/permission-rules.ts)) は
**監査注記のための近似であって許可判断の正本ではない** (正本は Claude Code)。
判定できなければ `null` に倒す。 `outcome=auto-allowed` かつ `rule=null` の集まりが
「settings.json に無いのに自動で通っているもの」 = 設定漏れ候補。

集計は `lictor cli permission-audit [--date YYYY-MM-DD] [--file <path>]`
([`../../src/permission-audit-report.ts`](../../src/permission-audit-report.ts))。

## 運用

- `Concordia` 側の `conn_permission_requests_enabled` は kill switch として残す。
  カードが出るのは実際に停止した要求だけなので、 既定で有効にしてよい。
- Notification hook は
  [`../../src/harness-hook.ts`](../../src/harness-hook.ts) が per-session settings に
  matcher 無しで登録する。

## テスト
- `tests/permission-hook.test.ts` — hook プロセスが観測を送信しても stdout に decision を
  書かないこと、不正な sidecar port でも exit 0 になること。
- `tests/permission-runtime.test.ts` — 記録 → Notification → 投稿 → 打鍵回答の全経路、
  待機催促の除外、 二重回答防止、 回答期限切れ・dispose 後の無効化、 Concordia 不達時の劣化。
- `tests/permission-proxy.test.ts` — HTTP 経路 (どの mode でも decision を返さず
  カードも出さないこと、 Notification 起点の回答が `via: "keystroke"` になること)。
- `tests/permission-notification.test.ts` — message 分類・観測バッファ・打鍵列。
- `tests/permission-rules.test.ts` — 規則マッチ・層の読み込み・迂回検出・監査集計。
