---
title: "Implementation fast-path CLI"
status: in-progress
service: lictor
updated: 2026-08-06
---

# Implementation fast-path CLI

- [x] 通常セッションへ介入しない `implement begin` opt-in を追加する。
- [x] project code、session id、Cc endpoint を CLI 利用者から隠す。
- [x] service control を Cc の claim/control/release 遷移へ中継する。
- [x] Revisor submit/retry を一つの `implement review` にする。
- [x] session-level stateを追加せず、複数実装を独立した複合requestとして扱う。
- [ ] Revisor review と配布後の smoke check で CLI/API contract を確認する。
