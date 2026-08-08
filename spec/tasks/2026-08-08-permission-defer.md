# Deferred self-processable permission notifications

- [x] Forward Claude Code's `permission_mode` and guard outcome through the permission hook.
- [x] Classify only known auto-approval modes and harmless read-only tools as self-processable.
- [x] Defer self-processable notifications for five seconds and suppress them when transcript progress is observed.
- [x] Keep immediate human-confirmation requests pending for up to ten minutes, returning `ask` on expiry.
- [x] Preserve structured local audit records for deferred requests that were automatically resolved.
- [x] Cover classification, deferred-progress suppression, stalled posting, and immediate human-confirmation behavior with node:test.

## Verification

- `npm run typecheck` passed.
- `npm test` passed (431 tests).

## Follow-up

- After merge, run `npm run build` from the Lictor checkout because production launches `dist/cli.js`.
