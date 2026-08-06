# submit-watchdog test timing flake

- Status: fixed
- Detected: 2026-08-05
- Affected review: Revisor local PR #213 (`LUDIARS/Lictor`)

## Symptom

The registered `npm test` run completed 372 tests with one failure:
`submit-watchdog: keeps sending Enter until a user message is observed` expected at least two
writes but observed one. The test configured a 15 ms retry interval, slept for 55 ms, and
assumed the event loop would run at least two callbacks in that wall-clock window.

## Cause

The production watchdog reschedules correctly after every timeout, but the test used real
timers. Under a loaded full-suite run, callback scheduling is not guaranteed to match the
elapsed wall-clock duration, so the assertion measured runner load rather than watchdog state.

## Resolution

All submit-watchdog tests now use Node's mock timers and advance each timeout boundary
explicitly. The tests deterministically cover the initial retry, repeated retry, cancellation,
re-arm, disabled mode, stop, and write-error recovery without sleeping.

## Regression guard

`tests/submit-watchdog.test.ts` must not use wall-clock sleeps to count watchdog retries.
