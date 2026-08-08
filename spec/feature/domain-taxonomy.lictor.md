# Domain taxonomy: lictor

This curated taxonomy registers the Lictor paths changed by the task-declaration
reliability fix for Anatomia domain detection. It defines responsibility boundaries;
it does not move code or add architecture gates.

## session-coordination

Per-session CLI and sidecar control paths that declare work to Concordia, apply
confirmed provider settings, and keep optional observability outside the control
dependency chain.

- **task-declaration-cli**: short-lived `lictor cli task get/set` dispatch and the
  sidecar task relay (`src/cli.ts`, `src/task-relay.ts`).
- **optional-observability-boundary**: best-effort Vestigium loading for long-running
  providers and `cli local-agent` only (`src/vestigium.ts`).
- **runtime-model-effort-control**: validate and apply an already-confirmed model/effort
  pair to the wrapped provider, serialize PTY writes, and report explicit runtime
  metadata (`src/runtime-model-effort.ts`, `src/provider-runtime-metadata.ts`,
  `src/sidecar.ts`). Genius judgment and confirmation UI remain Cc responsibilities.
- **root-build-freshness**: prevent the source checkout from starting an older ignored
  `dist/` bundle (`bin/lictor.mjs`, `scripts/ensure-root-build.mjs`).

The command contract and dependency boundary are specified in
[`task-protocol.md`](./task-protocol.md). Vestigium degradation behavior is specified
in [`../setup/setup.md`](../setup/setup.md). Runtime provider application is specified
in [`runtime-model-effort.md`](./runtime-model-effort.md); root build freshness is
specified by `SETUP-ROOT-BUILD-FRESHNESS`.

## permission-governance

Claude Code's PreToolUse permission routing. This domain owns the boundary between
Claude-native automatic permission decisions and the coordinator-backed permission
proxy.

- **claude-native-auto-boundary**: normalize and recognize Claude's current
  `permission_mode: "auto"`, then emit no hook decision so Claude Code applies its
  own permission policy (`src/permission-hook.ts`, `src/permission-mode.ts`).
- The coordinator-backed proxy remains responsible for every other permission mode
  (`src/permission-hook.ts`, `src/permission-classify.ts`); it is deliberately not
  allowed to reinterpret Claude-native `auto` as a human-confirmation request.

The behavioral contract is [`permission-proxy.md`](./permission-proxy.md)
(`SPEC-PERMISSION-PROXY`).

## ask-marker-relay

The text-protocol question path: deciding whether ask markers are detectable,
steering the model to emit them, parsing them out of the transcript, and getting
them to Concordia without ever dropping a question silently.

- **activation-planning**: pure provider/Concordia/injector → enabled + injection
  decision (`src/ask-marker-activation.ts`). Detection capability is deliberately
  independent of session-scoped skill injection, because Codex declares
  `supportsSkills: false` and therefore has no `SkillInjector`.
- **marker-parsing**: steering bodies, prompt file writing, lenient JSON extraction
  and the raw-ask fallback rendering (`src/ask-marker.ts`, `src/ask-json.ts`).
- **pending-question-egress**: pending-question POST / resolve and option
  normalization (`src/ask-question-relay.ts`).

The relay contract (split send order, single card post, raw fallback on registration
failure, and which side strips raw markers) is specified in
[`transcript-relay.md`](./transcript-relay.md) (`SPEC-ASK-MARKER-ACTIVATION`,
`SPEC-ASK-MARKER-RELAY-CONTRACT`). Gate behavior for
registered questions is specified in
[`askquestion-pending-gate.md`](./askquestion-pending-gate.md).

### Analyzer policy boundary

Lictor does not adopt Anatomia's built-in `transition-guard-example` policy. Names such as
`NotifyState` and `TaskState` are ordinary immutable state values; calls that construct them
from `runWrapped` are not forbidden direct state mutation. The tracked local override keeps
that example policy rule-free so it cannot block unrelated wrapper changes.
