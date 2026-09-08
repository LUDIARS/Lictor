# Codex session replacement leaves Lictor relaying the previous conversation

- Date: 2026-09-08
- Status: fixed in working tree; review and runtime rollout pending
- Area: transcript discovery / legacy Codex PTY
- Severity: remote conversation relay stops while session appears active

## Summary

Discord thread 1546761250900545588 stopped receiving replies while its Lictor PTY
remained alive. This is a recovery regression: a new Codex conversation inside the
existing wrapper cannot replace the original locked transcript.

## Evidence

- Last old-transcript activity: 2026-09-08 19:39 JST.
- Original rollout metadata timestamp: 2026-09-08T05:57:01.235Z.
- Replacement rollout metadata timestamp: 2026-09-08T10:39:14.633Z.
- Both have source `cli`, cwd `E:\Document\Ars`, and the same unique Lictor
  originator; their session IDs differ. Neither is a subagent.
- Concordia still reported the original transcript path after replacement.
- The user reports Chat Stop Precaution preceding the restart; the trigger itself
  has not been independently established.

## Regression Context

The session-ID lock prevents cross-session relay. `recoverCodexLocked` previously
only rediscovered the same ID, so a surviving PTY concealed a conversation change.

## Cause

`discoverCodex` in `src/transcript-tail.ts` filters all later discovery by the first
bound session ID. `getSessionUuid` consequently also remains stale.

## Fix Requirements

Legacy Codex discovery may advance only to a strictly newer top-level CLI
conversation with the exact wrapper-generated originator. Use metadata creation
time, never file mtime, for ordering. Reject ambiguous ties, shared/custom
originators, subagents and foreign cwd candidates. Preserve explicit App Server
thread pins. Claim and validate the replacement before releasing the old claim.
Reset the read cursor and deduplication state, then report the new authoritative
path through the existing Concordia callback; retain the Concordia session ID.

## Verification

Revisor should exercise transcript recovery with these cases:

- Old file still exists; a later owned CLI rollout appears: repin/watchdog switches
  path and provider ID, relays new frames once, and reports the new path.
- Foreign wrapper, cwd, exec or subagent metadata: no switch.
- Missing/malformed metadata, equal timestamps, older rollout with newer mtime:
  no switch. Explicit App Server thread pin and custom originator remain locked.
- Replacement claim is held elsewhere: retain old binding and claim.
- Sequential replacements advance without replaying old frames; stopping releases
  the current claim. Discovery retains its existing 30-second stall throttle.

`tests/codex-transcript-successor.test.ts` pins the selection half of that matrix:
owned-newer switch (string and variant `source`), foreign/custom originator, exec,
subagent, `parent_thread_id`, equal timestamps, older-or-same conversation,
malformed/missing metadata, and sequential advancement.

The binding half — claim hand-off, cursor/dedupe reset, and the Concordia path
report on an actually running wrapper — has no automated coverage and still needs
a runtime check. Session tests were not run, following the Revisor workflow.

## Follow-up

Running wrappers keep their loaded code until an approved lifecycle transition.
Do not claim the affected live thread recovered from a source change alone.
