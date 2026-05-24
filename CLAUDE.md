# Lictor — CLAUDE notes

LUDIARS short code: **Li**. See `README.md` for usage, `DESIGN.md` for
architecture.

## When working on this repo

- Stack: Node ≥ 22 (we use the global `WebSocket`), TypeScript (strict),
  no native deps. Keep it that way — the value proposition is "drop-in
  wrapper for `claude`", so a `node-pty` or `ws` native build break would
  kill adoption.
- Test runner: built-in `node:test` via `tsx`. No vitest / jest.
- All HTTP endpoints must keep the `127.0.0.1` guard. This is a security
  invariant, not a code style preference.
- Title sanitization (`src/osc.ts`) is the trust boundary. New writers
  must funnel through `setTitle` / `writeOsc`, never `process.stdout.write`
  directly with raw payloads.
- Concordia integration is best-effort. Anything that calls Concordia
  must catch and degrade — Lictor users should never see a stack trace
  from a coordinator outage.

## When adding a sidecar endpoint

1. Document in `README.md` table.
2. Add to `DESIGN.md` if it changes the protocol surface (new verb / new
   Concordia call).
3. Loopback guard runs first in every handler (already true: all routes
   funnel through `handle` in `sidecar.ts`).
4. Body cap stays at 64 KiB unless there's a real reason to raise it.
5. If the endpoint proxies to Concordia, return 503 (not 500) when
   `ctx.concordia` is null. Tests must cover the null path — see
   `tests/smoke-sidecar.mjs`.

## Running smoke / round-trip checks

```sh
npm test                                  # unit tests (15 cases, no network)
npx tsx tests/smoke-sidecar.mjs           # in-process sidecar, no Concordia
npx tsx tests/smoke-roundtrip.mjs         # registers a real Concordia session
```

`smoke-roundtrip.mjs` requires Concordia on `127.0.0.1:17330` and will
create + delete a real `lictor-smoke-<uuid>` session. It's a tracked file
but not part of `npm test`.

## Cross-repo touchpoints

- `LUDIARS/LUDIARS` (`PROJECT-CODES.md`) — Li registered (PR #21 merged).
- `LUDIARS/Concordia` — Lictor depends on `/v1/sessions`, `/v1/stat/:id`,
  `/v1/chat`, `/v1/sessions/:id/event`, `/v1/monitor/conflicts`, and
  `/ws?session=`. Breaking changes there should bump Lictor's compat
  surface.
- Skill `window-title-ja` — should be updated to call `lictor cli title`
  when `$LICTOR_PORT` is set, falling back to "manual rename" when not.
