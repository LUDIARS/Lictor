# Domain taxonomy: lictor

This curated taxonomy registers the Lictor paths changed by the task-declaration
reliability fix for Anatomia domain detection. It defines responsibility boundaries;
it does not move code or add architecture gates.

## session-coordination

Per-session CLI and sidecar control paths that declare work to Concordia while
keeping optional observability outside the control dependency chain.

- **task-declaration-cli**: short-lived `lictor cli task get/set` dispatch and the
  sidecar task relay (`src/cli.ts`, `src/task-relay.ts`).
- **optional-observability-boundary**: best-effort Vestigium loading for long-running
  providers and `cli local-agent` only (`src/vestigium.ts`).

The command contract and dependency boundary are specified in
[`task-protocol.md`](./task-protocol.md). Vestigium degradation behavior is specified
in [`../setup/setup.md`](../setup/setup.md).
