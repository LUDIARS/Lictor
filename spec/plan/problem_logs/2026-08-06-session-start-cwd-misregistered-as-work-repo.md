# Session Start CWD Misregistered as Work Repository

- Date: 2026-08-06
- Status: fixed operationally; durable relay fix pending
- Area: Lictor/Cc session repository binding and Revisor local PR submission
- Severity: local PR submission blocked

## Summary

A cross-repository session started at `<workspace-root>` retained that process start directory as
its Cc `repo_path` even after work moved to Concordia and Lictor worktrees. The visible task and
`target_project` changed, but the repository binding used by local PR submission did not.

## Evidence

On 2026-08-06, local PR submission returned `repository_not_registered` for both feature branches.
The Cc session row contained `repo_path=<workspace-root>`, `repo_origin=null`, and `branch=main`,
while `target_project=<Lictor-worktree>`. Revisor already listed both
`LUDIARS/Concordia` and `LUDIARS/Lictor` as registered repositories.

## Regression Context

The task protocol required running `lictor cli task set` from the worktree, but that command only
updated task and branch. It did not guarantee that Cc's repository path and origin matched the
actual worktree. Treating the session start cwd as the work repository is invalid for umbrella
sessions.

## Cause

Repository identity was inferred from the session/process start cwd instead of the git worktree
where edits and commits were made. `target_project` was incorrectly treated as sufficient even
though local PR submission reads `sessions.repo_path`, `sessions.repo_origin`, and `sessions.branch`.

## Fix Requirements

- Resolve the work repository from the actual git worktree used for edits and commits.
- Never register the Ars workspace root for child-repository work.
- Keep Cc `repo_path`, `repo_origin`, and `branch` synchronized when the active worktree changes.
- Verify all three fields immediately before local PR submission.
- Do not interpret `repository_not_registered` as a missing Revisor registration until the session
  repository binding has been inspected.

## Verification

No automated tests were run under the session policy. A regression test should cover an umbrella
session that starts at Ars, switches to a child worktree, registers a task, and submits a local PR
using the child repository origin and feature branch.

## Follow-up

Update the Lictor-to-Cc repository relay so worktree changes update both `repo_path` and
`repo_origin`, then add the regression test above.
