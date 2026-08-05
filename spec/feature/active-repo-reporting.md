# active repo の正準 root 報告

Lictor は hook が記録した active repo の各 checkout について
`git rev-parse --git-common-dir` を使い、本体リポジトリ root を解決する。linked
worktree のディレクトリ名からプロジェクトを推測しない。

- 解決はプロセス内でキャッシュし、relay tick ごとに git を起動しない。
- git が無い、または非リポジトリなら入力パスをそのまま使う。
- 重複を除き、hook が記録した出現順を維持する。
- active checkout または一覧のどちらかが変わったら、Cc の session へ
  `active_repos` を PATCH し、`lictor.active_repo.changed` を通知する。
- `repo_path` は既存契約どおり直近 checkout のパスを維持する。

設計正本は Concordia `spec/feature/session-surface-project-codes.md` §2.1。
