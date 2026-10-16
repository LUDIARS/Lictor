# Implementation binding relay (LI-BIND-01)

Status: implementation contract; user experience acceptance remains unverified.

User value: an agent can distinguish a rejected repository registration from an
unknown result, so it does not submit work against a stale project or blindly
repeat a write. Cc owns repository/project resolution and atomic session binding;
Lictor session-coordination owns session stamping and the loopback HTTP relay.

Invariants:

- Keep the current session id authoritative and retain loopback/body guards.
- A Cc 409 implementation_bind_failed remains HTTP409, not a generic HTTP500.
  Return only allowlisted reason/stage tokens and fixed guidance. Never relay
  arbitrary upstream diagnostics, paths, tokens or exception messages.
- binding=unchanged is asserted only when Cc explicitly supplies that fact.
  Legacy rejections and transport/unreadable responses have binding=unknown.
- A transport/protocol failure becomes a safe HTTP502 with result-unknown
  guidance. No automatic retry, checkout switch or substitute task registration.
- Success remains Cc's response. Do not rewrite session/task state in Lictor.

Source/test mapping: src/implementation-bind.ts → tests/implementation-bind.test.ts;
src/concordia.ts + src/sidecar.ts → tests/implementation-tools.test.ts.
The client-level test covers actual delegation to the new relay.

Recovery: revert the adapter/relay change; no data migration. After main merge,
build the main Lictor folder. Existing wrappers retain old code until their normal
restart/re-spawn; this change does not restart a live session.

Validation: source inspection, diff check and TypeScript no-emit check passed;
session tests and service startup
not executed. Revisor must execute the registered review checks.
