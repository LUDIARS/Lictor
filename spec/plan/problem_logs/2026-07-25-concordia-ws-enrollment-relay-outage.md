# Concordia WebSocket Enrollment Relay Outage

- Date: 2026-07-25
- Status: fixed in working tree
- Area: Concordia session WebSocket / Lictor event relay
- Severity: high — remote injects and replies stopped for Codex and Claude sessions

## Summary

After Concordia was rebuilt and restarted, Lictor-wrapped Codex and Claude sessions registered but did not receive session-targeted events. This was a regression in the cross-repository integration contract.

At the same time, Codex transcript discovery printed a rejected candidate message every 500 ms, obscuring the authentication failure and increasing terminal/log load.

## Evidence

Concordia repeatedly logged the following for active Lictor sessions:

```text
ws session claim rejected: invalid enrollment
```

Lictor repeatedly logged:

```text
[verbose-transcript] candidate rejected by meta filter path=...\rollout-....jsonl owner=lictor-...
```

The rejected rollout belonged to Codex Desktop rather than the wrapped child, so rejecting it was correct. Repeating the diagnostic on every discovery poll was not.

Relevant code before the fix:

- `src/concordia.ts`: `LivenessHandle.connect()` opened `/ws?session=<id>` without enrollment.
- `src/wrap.ts`: registration included `metadata.concordia_spawn_id`, but neither liveness open passed that value.
- `src/transcript-tail.ts`: `LICTOR_DEBUG_TRANSCRIPT` was enabled unless explicitly set to `0`.

## Regression Context

Concordia has required the registered `concordia_spawn_id` as the session WebSocket enrollment since 2026-07-22. Lictor did not implement that side of the contract. The mismatch remained dormant until Concordia was restarted with the enforcing build.

Repository-local tests covered registration metadata and WebSocket event handling separately, but did not assert that the registered spawn identity was carried into both Lictor WebSocket opens.

## Cause

Lictor consumed `CONCORDIA_SPAWN_ID` for session registration metadata only. Its initial liveness socket and later reactor socket omitted the same credential. Concordia accepted the HTTP registration and then closed every session WebSocket with policy code 1008. Because the socket briefly opened before closing, Lictor reset its backoff and retried once per second indefinitely.

## Fix Requirements

- Reuse the existing `CONCORDIA_SPAWN_ID`; add no environment variable or configuration.
- Pass the registered spawn identity explicitly to the initial and reactor WebSocket opens.
- URL-encode the session and enrollment query parameters.
- Never log the enrollment value.
- Treat WebSocket close code 1008 as terminal for the immutable credential and do not reconnect.
- Keep transcript candidate debug output disabled by default, using only the existing `LICTOR_DEBUG_TRANSCRIPT=1` opt-in.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `tests/concordia.test.ts`: 9/9 passed, including URL encoding, credential omission, Fake WebSocket 1008 no-reconnect behavior, credential redaction, and retry after a transport close.
- Full `npm test`: 343/344 passed. The sole failure is the pre-existing environment-dependent `active-repos` assertion that rejects any fallback path beginning with `E:`; the isolated worktree itself is correctly located on `E:`.
- `git diff --check`: passed.

## Follow-up

After merge, rebuild/restart Lictor through the normal service owner and verify that newly spawned Codex and Claude sessions keep a connected session WebSocket and receive targeted injects.
