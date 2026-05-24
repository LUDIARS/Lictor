# Lictor — CLAUDE notes

LUDIARS short code: **Li**. See `README.md` for usage, `DESIGN.md` for
architecture.

## When working on this repo

- Stack: Node ≥ 20, TypeScript (strict), no native deps. Keep it that way —
  the value proposition is "drop-in wrapper for `claude`", so a `node-pty`
  build break would kill adoption.
- Test runner: built-in `node:test` via `tsx`. No vitest / jest.
- All HTTP endpoints must keep the `127.0.0.1` guard. This is a security
  invariant, not a code style preference.
- Title sanitization (`src/osc.ts`) is the trust boundary. New writers
  must funnel through `setTitle` / `writeOsc`, never `process.stdout.write`
  directly with raw payloads.

## When adding a sidecar endpoint

1. Document in `README.md` table.
2. Add to `DESIGN.md` if it changes the protocol surface (new verb).
3. Loopback guard runs first in every handler.
4. Body cap stays at 64 KiB unless there's a real reason to raise it.

## Cross-repo touchpoints

- `LUDIARS/LUDIARS` (`PROJECT-CODES.md`) — Li registered here.
- `LUDIARS/Concordia` — future: `/v1/event` will forward to Concordia at
  `127.0.0.1:17330`.
- Skill `window-title-ja` (under `~/.claude/skills/...`) — eventually points
  at `lictor cli title` instead of the legacy `window-title.mjs` helper.
