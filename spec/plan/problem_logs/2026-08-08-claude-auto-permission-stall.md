# Claude `auto` permission mode stalled through Lictor

## Incident

Claude delegation sessions configured with `permissionMode: "auto"` were
still routed through Lictor's coordinator-backed `PreToolUse` permission
hook.  The classifier did not recognise `auto`, so ordinary tools (including
`Bash`) entered the human-confirmation path and waited up to 600 seconds.

One observed Opus delegation hook completed after `602053ms` with
`permissionDecision: "ask"` and reason `human confirmation timed out`.

## Cause

`src/permission-classify.ts` recognises only legacy auto-like modes
(`acceptEdits`, `bypassPermissions`, and `dontAsk`).  Sending current
Claude `auto` mode into the proxy also overrides Claude's own automatic
permission path with a second, hidden coordinator wait.

## Correction

The hook now emits no Lictor decision for `permission_mode: "auto"`, letting
Claude Code decide under its configured auto policy immediately.  Other modes
keep the existing coordinator confirmation behaviour.  This intentionally
does not alter `delegation-run-watchdog`, whose re-enablement has a separate
permission-dialog regression and is being handled by its existing diff.

## Verification

- Unit coverage recognises only the exact current `auto` mode (case and outer
  whitespace insensitive).
- Existing permission-proxy behaviour remains unchanged for all other modes.
