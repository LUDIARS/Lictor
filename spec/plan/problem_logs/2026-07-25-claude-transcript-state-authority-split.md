# Claude Transcript State Authority Split

- Date: 2026-07-25
- Status: fixed in working tree
- Area: Lictor Claude SessionStart hook / transcript relay
- Severity: high — Claude received remote injects and replied, but the reply never reached Concordia/Discord

## Summary

This was a pre-existing cross-process authority regression exposed by the 2026-07-25 smoke test. The Lictor wrapper and its Claude SessionStart hook independently resolved the transcript state directory from different environment snapshots. The hook wrote the correct transcript JSONL pointer to one directory while transcript-tail watched another forever.

## Evidence

At 2026-07-25 10:46 JST, smoke session `lictor-6ffb91c7-bfa8-4c5f-81cf-b319a7c7a62c` received a targeted inject and Claude wrote the exact requested reply to:

```text
C:\Users\raury\.claude\projects\E--Document-Ars-Lictor\7a4d00d4-551c-4a31-88fd-174511441e48.jsonl
```

The SessionStart hook wrote its authority pointer under:

```text
E:\Document\Ars\Lictor\.claude\state
```

The wrapper watched:

```text
E:\Document\Ars\.claude\state
```

The sidecar consequently reported `path: null, available: false`, and Concordia recorded zero transcript frames for the session.

## Regression Context

The divergent assumptions predate the 2026-07-23 review baseline:

- `resolveActiveReposDir` gave `CLAUDE_PROJECT_DIR` precedence in `eae7ab0` (2026-05-25).
- wrapper transcript authority path was added in `a78274d` (2026-06-30).
- the SessionStart state hook originated in `314cb77` / `5a51af0` (2026-06-26/27).

Therefore Lictor PR #94 and the WebSocket enrollment fix PR #95 did not introduce this defect. PR #95 restored targeted inject delivery, which allowed the separate return-relay failure to be observed.

## Cause

`wrap.ts` resolved the state directory before spawning Claude. Its environment had `LUDIARS_ROOT` but no `CLAUDE_PROJECT_DIR`, so it selected the workspace state directory.

Claude adds `CLAUDE_PROJECT_DIR` when executing hooks. `session-id-hook.ts` called `resolveActiveReposDir()` again in that changed runtime environment and selected the project-local state directory. The comment in `wrap.ts` claiming both sides received the same environment was incorrect.

## Fix Requirements

- Resolve the state directory once in the wrapper.
- Pass that exact authority to the generated SessionStart hook command.
- Add no environment variable or user configuration.
- Keep paths with Windows backslashes, spaces, Unicode, and shell metacharacters safe.
- Use the same resolved directory for transcript-tail.
- Preserve compatibility with old generated settings that have no explicit authority argument.

## Verification

- Added a production-path regression test that executes the hook payload writer with a conflicting runtime `CLAUDE_PROJECT_DIR`, then proves both state files exist only under the wrapper authority.
- Added base64url argument round-trip tests for Windows paths containing spaces, backslashes, and shell metacharacters.
- Added generated hook command coverage.
- Focused tests: 9/9 passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Full `npm test`: 347/349 passed. One failure is the pre-existing E:-drive-dependent `active-repos` assertion. The other (`local-hooks`) passed 3/3 immediately when rerun in isolation and is unrelated to this path.
- `git diff --check`: passed.

## Follow-up

After merge, spawn a new Claude session and verify both the sidecar transcript endpoint and Concordia transcript storage contain the injected user turn and Claude reply. Remove the temporary worktree after that operational check.
