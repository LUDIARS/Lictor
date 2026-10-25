# Session collaboration

Status: implementation draft, 2026-10-25. Human scope: neco requests Lictor to
coordinate multiple sessions, maintaining WS links and parent/child instructions
and questions instead of stopping after Actio registration.

Task: actio:c43c8731-9399-4562-9a76-24077c6dc7a1. Task creation and content read
succeeded; Cc instruction-to-task linking returned 503 actio_task_unavailable
(including retry after a successful content read). Link state is unconfirmed;
do not create a duplicate task to compensate.

## LI-COLLAB-01 — Maintain the relationship

The session-coordination domain owns the local collaboration view. Concordia
delegation runs remain authoritative for relationships and lifecycle; Actio owns
task status. Lictor reuses its enrolled Cc WebSocket (no impersonated child socket,
new listener, agent spawn, or independent task state machine).

On WS hello/reconnect, restore own child run and runs delegated by this session.
On run change, reconcile that run. Observe linked sessions' messages and lifecycle
events, keeping bounded latest progress and pending questions. Notify the local
agent about relationship/status changes and lost peers through the existing safe
injection path. Do not inject every transcript frame, echo received instructions,
duplicate Cc question relay, or equate process exit with task completion.

## LI-COLLAB-02 — Address by relationship

Expose loopback GET /v1/collaboration and POST /v1/collaboration/message and
/v1/collaboration/answer. Caller supplies run_id, never arbitrary session identity.
Resolve and validate the current run immediately before sending; stamp source
identity internally. Parent instructions use Cc's delegation inject route; child
messages go to the run's parent. Answers use Cc's existing question lifecycle.
Human permission gates remain authoritative; no automatic answer or approval.

## LI-COLLAB-03 — Recovery and resources

Read reconciliation is serialized/coalesced, bounded and cancellable on shutdown.
Disconnected/error state is visible, not presented as current. Never retry a
mutation automatically: acceptance is not delivery/processing acknowledgement.
Reconnect performs reads, never repeats instructions or answers. Full reconciliation
must not silently claim completeness if the API list cap is reached.

## Evidence and acceptance

- Li base: 4dda72b; Cc src/api/ws.ts broadcasts delegation.run_changed but Li
  src/event-reactor.ts ignores it. Existing Cc coordination.ts already implements
  question relay; reuse it instead of inventing a second question workflow.
- Pf Lictor project 01M3FVMFRKZDMZ62MKQ0ECJV9M UX revision 1 is a draft.
- Anatomia lictor context identifies session-coordination and delegation-inject;
  direct source inspection establishes the missing runtime collaboration owner.
- Genius query unavailable from task cwd (missing config); no cards inferred.
- Acceptance: relationship recovery, unrelated-session isolation, changed child
  binding, progress observation, duplicate suppression, question routing, upstream
  outage, unknown mutation outcome, shutdown and reconnect are covered by tests.
- Tests are authored for Revisor; local unit/integration/service execution is not
  authorized by the active workflow. Runtime rollout remains separately verified.
- TypeScript source and the three new test files pass static typechecking.
  This does not constitute runtime execution. Peer question state after reconnect
  is explicitly unknown until a new question lifecycle event is observed; the
  existing Cc parent-first question delivery/escalation remains authoritative.
